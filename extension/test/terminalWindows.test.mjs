// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTerminalHost, launchVisibleTerminal, loadTerminalRuntime } from "../src/terminalHost.mjs";

const enabled = process.platform === "win32" && process.env.WEFT_TEST_VISIBLE_TERMINAL === "1";

async function typeIntoOwnedConsole(launcherPid) {
  const script = `
$ErrorActionPreference = "Stop"
$owned = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $env:WEFT_TEST_LAUNCHER_PID" | Where-Object Name -eq 'node.exe')
if ($owned.Count -ne 1) { throw "Expected exactly one owned attach client." }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WeftConsoleInput {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Key {
    [MarshalAs(UnmanagedType.Bool)] public bool down;
    public ushort repeat, virtualKey, scan;
    public char character;
    public uint modifiers;
  }
  [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode)]
  public struct Record {
    [FieldOffset(0)] public ushort type;
    [FieldOffset(4)] public Key key;
  }
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool WriteConsoleInputW(IntPtr handle, Record[] records, uint count, out uint written);
  public static void Type(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) throw new Exception("Cannot attach to owned console.");
    string text = "Write-Output ('LOCAL_' + 'PTY_OK')\\r";
    var records = new Record[text.Length];
    for (int i=0; i<text.Length; i++) {
      records[i].type = 1;
      records[i].key = new Key { down=true, repeat=1, character=text[i], virtualKey=(ushort)(text[i]=='\\r' ? 13 : 0) };
    }
    uint written;
    IntPtr handle = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    try {
      if (!WriteConsoleInputW(handle, records, (uint)records.Length, out written) || written != records.Length)
        throw new Exception("Cannot write owned console input.");
    } finally { CloseHandle(handle); }
    FreeConsole();
  }
}
'@
[WeftConsoleInput]::Type([uint32]$owned[0].ProcessId)
`;
  await promisify(execFile)(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, timeout: 10000, env: { ...process.env, WEFT_TEST_LAUNCHER_PID: String(launcherPid) },
    });
}

test("real ConPTY shares one visible console, reconnects, resizes, and closes", { skip: !enabled, timeout: 30_000 }, async (t) => {
  const messages = [];
  let child, launches = 0, clientError = "";
  const host = createTerminalHost({
    allowTerminal: true,
    projectsApi: { listProjects: () => [{ name: "integration", path: process.cwd(), default: true }] },
    send: async (message) => messages.push(message),
    loadRuntime: loadTerminalRuntime,
    launchVisible(options) {
      launches++;
      child = launchVisibleTerminal(options);
      child.stderr?.on("data", (data) => { clientError = (clientError + data).slice(-2048); });
      return child;
    },
  });
  t.after(() => host.stop());
  const request = (action, fields = {}) => host.handle({
    requestId: randomUUID(), action, ...(action === "open" ? {} : { terminalId: host.terminalId }), ...fields,
  });
  await request("open");
  assert.ok(host.terminalId, `${messages.at(-1)?.msg.error ?? "Real terminal did not open."} ${clientError}`);
  const id = host.terminalId;
  assert.equal(launches, 1);
  assert.ok(child.pid);
  // The visible attach handshake succeeds only after the client establishes real raw-mode
  // CONIN$/CONOUT$ streams. The shell remains owned by Station, not by that client.
  await request("input", { inputSeq: 1, data: "Write-Output ('WEFT_' + 'PTY_OK')\r" });
  const deadline = Date.now() + 8000;
  while (!messages.filter((message) => message.eventSubtype === "terminal_output").map((message) => message.msg.data).join("").includes("WEFT_PTY_OK")) {
    if (Date.now() > deadline) assert.fail("The real managed shell did not produce the expected marker.");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await request("resize", { cols: 100, rows: 30 });
  await request("detach");
  await request("attach");
  assert.equal(host.terminalId, id);
  assert.equal(launches, 1);
  const snapshot = messages.at(-1);
  assert.equal(snapshot.eventSubtype, "terminal_snapshot");
  assert.match(snapshot.msg.data, /WEFT_PTY_OK/);
  assert.equal(snapshot.msg.cols, 100);
  assert.equal(snapshot.msg.rows, 30);
  await typeIntoOwnedConsole(child.pid);
  const localDeadline = Date.now() + 5000;
  while (!messages.filter((message) => message.eventSubtype === "terminal_output").map((message) => message.msg.data).join("").includes("LOCAL_PTY_OK")) {
    if (Date.now() > localDeadline) assert.fail("Local console input did not reach the managed shell.");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(messages.filter((message) => message.eventSubtype === "terminal_state").at(-1).msg.owner, "laptop");
  await request("claim");
  await request("input", {
    inputSeq: 2,
    data: "$p=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 60' -NoNewWindow -PassThru; Write-Output ('CHILD_' + $p.Id)\r",
  });
  let descendant;
  const childDeadline = Date.now() + 5000;
  while (!descendant) {
    const text = messages.filter((message) => message.eventSubtype === "terminal_output").map((message) => message.msg.data).join("");
    descendant = Number(text.match(/CHILD_(\d+)/)?.[1]) || null;
    if (Date.now() > childDeadline) assert.fail("The shell did not report its owned descendant.");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  t.after(() => {
    try { process.kill(descendant); } catch (error) { if (error.code !== "ESRCH") throw error; }
  });
  await request("close");
  assert.equal(host.terminalId, null);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.notEqual(child.exitCode, null);
  assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
});

for (const close of ["shell-exit", "window-process-close"]) {
  test(`real ${close} propagates closure to Station`, { skip: !enabled, timeout: 30_000 }, async (t) => {
    const messages = [];
    const markerSuffix = randomUUID();
    const finalMarker = `WEFT_FINAL_${markerSuffix}`;
    let child, nativePty, nativeExit, exitSubscription;
    let killCalls = 0;
    const host = createTerminalHost({
      allowTerminal: true,
      projectsApi: { listProjects: () => [{ name: "integration", path: process.cwd(), default: true }] },
      send: async (message) => messages.push(message),
      loadRuntime: async () => {
        const runtime = await loadTerminalRuntime();
        return {
          ...runtime,
          pty: {
            spawn(...args) {
              nativePty = runtime.pty.spawn(...args);
              const kill = nativePty.kill.bind(nativePty);
              nativePty.kill = (...signals) => { killCalls++; return kill(...signals); };
              exitSubscription = nativePty.onExit(({ exitCode }) => {
                nativeExit = { exitCode, beforeCleanupKill: killCalls === 0 };
              });
              return nativePty;
            },
          },
        };
      },
      launchVisible(options) { child = launchVisibleTerminal(options); return child; },
    });
    t.after(async () => { await host.stop(); exitSubscription?.dispose(); });
    await host.handle({ requestId: randomUUID(), action: "open" });
    assert.ok(host.terminalId, messages.at(-1)?.msg.error);
    if (close === "shell-exit") {
      await host.handle({
        requestId: randomUUID(), action: "input", terminalId: host.terminalId,
        // One PTY write prints a per-run marker and exits immediately. Splitting its
        // literal in PowerShell prevents echoed command text from satisfying the assertion.
        inputSeq: 1, data: `Write-Output ('WEFT_FINAL_' + '${markerSuffix}'); exit\r`,
      });
    } else {
      // End only our launcher's descendant tree, the same abrupt IPC loss caused by closing
      // its dedicated visible console. Never target a process name or another desktop window.
      const { spawnSync } = await import("node:child_process");
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }

    const deadline = Date.now() + 10_000;
    while (host.terminalId !== null) {
      if (Date.now() > deadline) assert.fail("Owned terminal did not close.");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(messages.at(-1).msg.status, "closed");
    if (close === "shell-exit") {
      const closed = messages.findIndex((message) => message.msg.status === "closed");
      assert.ok(messages.slice(0, closed).filter((message) => message.eventSubtype === "terminal_output")
        .map((message) => message.msg.data).join("").includes(finalMarker));
      assert.equal(messages.slice(closed).some((message) => message.eventSubtype === "terminal_output"), false);
      assert.deepEqual(nativeExit, { exitCode: 0, beforeCleanupKill: true });
      assert.throws(() => process.kill(nativePty.pid, 0), { code: "ESRCH" });
    }
  });
}

test("isolated built distribution opens a real terminal without repository node_modules", {
  skip: !enabled || process.env.WEFT_TEST_INSTALLED_TERMINAL !== "1", timeout: 30_000,
}, async (t) => {
  const extension = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(join(tmpdir(), "weft-terminal-installed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(join(extension, "dist", "weft.mjs"), join(dir, "weft.mjs"));
  cpSync(join(extension, "dist", "node_modules"), join(dir, "node_modules"), { recursive: true });
  const { build } = await import("esbuild");
  await build({
    entryPoints: [join(extension, "src", "terminalHost.mjs")],
    outfile: join(dir, "terminalHost.mjs"), bundle: true, platform: "node", format: "esm", target: "node20",
    external: ["node-pty"],
    banner: { js: "import { createRequire as makeRequire } from 'node:module'; const require = makeRequire(import.meta.url);" },
    logLevel: "silent",
  });
  const installed = await import(pathToFileURL(join(dir, "terminalHost.mjs")).href);
  assert.equal(installed.terminalCliPath(), join(dir, "weft.mjs"));
  // Load native DLLs in a short-lived process so Windows releases its image locks before
  // removing the temporary installed distribution.
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import { randomUUID } from "node:crypto";
        import { pathToFileURL } from "node:url";
        import { join } from "node:path";
        const dir = process.env.WEFT_TEST_TERMINAL_BUNDLE;
        const installed = await import(pathToFileURL(join(dir, "terminalHost.mjs")).href);
        const messages = [];
        const host = installed.createTerminalHost({
          allowTerminal: true,
          projectsApi: { listProjects: () => [{ name: "installed", path: dir, default: true }] },
          send: async (message) => messages.push(message),
        });
        try {
          await host.handle({ requestId: randomUUID(), action: "open" });
          assert.ok(host.terminalId, messages.at(-1)?.msg.error ?? "Installed terminal failed.");
          await host.handle({
            requestId: randomUUID(), action: "input", terminalId: host.terminalId,
            inputSeq: 1, data: "Write-Output ('INSTALLED_' + 'PTY_OK')\\r",
          });
          const deadline = Date.now() + 10000;
          while (!messages.filter((message) => message.eventSubtype === "terminal_output").map((message) => message.msg.data).join("").includes("INSTALLED_PTY_OK")) {
            if (Date.now() > deadline) assert.fail("Installed ConPTY did not produce output.");
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          await host.handle({ requestId: randomUUID(), action: "close", terminalId: host.terminalId });
          assert.equal(host.terminalId, null);
        } finally {
          await host.stop();
        }
  `], { cwd: dir, env: { ...process.env, WEFT_TEST_TERMINAL_BUNDLE: dir, NODE_PATH: "" }, timeout: 25000 });
});
