// SPDX-License-Identifier: Apache-2.0
import { spawn as childSpawn } from "node:child_process";
import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeIdentityFile } from "./handoffIdentity.mjs";
import { appendStationLog } from "./stationLog.mjs";

export { writeIdentityFile } from "./handoffIdentity.mjs";

export function detectTerminal(env = process.env, platform = process.platform) {
  if (platform === "win32") return env.WT_SESSION ? "windows-terminal" : "windows-console";
  if (platform === "darwin") return "macos-terminal";
  if (platform === "linux" && (env.GNOME_TERMINAL_SCREEN || env.GNOME_TERMINAL_SERVICE)) {
    return "gnome-terminal";
  }
  return null;
}

export async function spawnCopilotSession({
  project,
  name,
  mode = "default",
  identity,
  resumeSessionId = null,
  operationId = null,
  operationOwnerToken = null,
  baseDir = undefined,
  spawnFn = childSpawn,
  platform = process.platform,
  copilotExecutable = "copilot",
} = {}) {
  const cwd = project?.path;
  if (!cwd) return { ok: false, error: "Project path is required" };
  const cleanup = [];
  const startedAt = Date.now();
  const operation = createHash("sha256").update(operationId ?? identity?.channelId ?? randomUUID()).digest("hex").slice(0, 12);
  const log = (event, fields, level = "info") => appendStationLog(event, { operation, ...fields }, { baseDir, level });
  try {
    const identityFile = writeIdentityFile(
      { ...identity, operationId, operationOwnerToken },
      { baseDir },
    );
    cleanup.push(identityFile);
    // Resume an existing session by id (keeps its stored name/history) vs. start a fresh one.
    // `--resume=<id>` uses the attached-value form so the CLI never treats the id as a positional
    // (its `-r, --resume[=value]` takes an OPTIONAL value). A fresh session is named only when the
    // user chose a name: a placeholder `-n` would be reported as the title (relay fetchTitle reads
    // `initialName`) and mask the folder fallback until Copilot derives its own title.
    const copilotArgs = resumeSessionId
      ? [`--resume=${resumeSessionId}`]
      : name ? ["-n", name] : [];
    if (mode === "allow-all") copilotArgs.push("--allow-all");
    // The direct-spawn path (no visible terminal) inherits this env correctly. The visible-terminal
    // launchers below can't rely on it — they route through a terminal broker with its own stale
    // environment — so they re-establish these vars inside the new shell via a launcher script.
    const env = {
      ...process.env,
      WEFT_IDENTITY_FILE: identityFile,
      WEFT_CHANNEL_ID: identity.channelId,
    };
    const terminal = detectTerminal(process.env, platform);
    log("launch.requested", { terminal: terminal ?? "direct", pid: process.pid });
    const launch = buildLaunch({ terminal, cwd, copilotArgs, identityFile, channelId: identity.channelId, platform, copilotExecutable });
    if (launch.launcherFile) cleanup.push(launch.launcherFile);
    if (launch.brokerFile) cleanup.push(launch.brokerFile);
    const child = spawnFn(launch.command, launch.args, {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    await waitForSpawn(child, terminal !== null);
    log("launch.broker_confirmed", { terminal: terminal ?? "direct", elapsedMs: Date.now() - startedAt });
    child?.unref?.();
    return {
      ok: true,
      identityFile,
      pid: terminal === null && Number.isInteger(child?.pid) && child.pid > 0 ? child.pid : null,
    };
  } catch (err) {
    log("launch.failed", { code: err?.code ?? err?.name ?? "Error", elapsedMs: Date.now() - startedAt }, "error");
    for (const file of cleanup) {
      try {
        unlinkSync(file);
      } catch {
        // best-effort cleanup after a failed spawn.
      }
    }
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function waitForSpawn(child, waitForExit = false) {
  if (!child || typeof child.once !== "function") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      child.removeListener?.("spawn", onSpawn);
      child.removeListener?.("error", onError);
      child.removeListener?.("close", onClose);
      clearTimeout(timer);
      fn(value);
    };
    const onSpawn = () => { if (!waitForExit) finish(resolve); };
    const onError = (err) => finish(reject, err);
    const onClose = (code) => code === 0 ? finish(resolve)
      : finish(reject, Object.assign(new Error(`Terminal launcher exited with code ${code ?? "unknown"}; Copilot startup was not confirmed.`),
        { code: "TERMINAL_LAUNCH_FAILED" }));
    const timer = waitForExit ? setTimeout(() => finish(reject,
      Object.assign(new Error("Terminal launcher did not confirm startup within 15 seconds."), { code: "TERMINAL_LAUNCH_TIMEOUT" })), 15_000) : null;
    child.once("spawn", onSpawn);
    child.once("error", onError);
    if (waitForExit) child.once("close", onClose);
  });
}

// A cmd.exe batch value inside `set "VAR=..."` needs no escaping except a literal double-quote,
// which cmd cannot represent inside a quoted value — strip any (our values are OS paths / random
// channel ids that never legitimately contain one).
function cmdSetValue(value) {
  return String(value).replace(/"/g, "").replaceAll("%", "%%");
}

// Quote a single copilot argument for a cmd.exe batch line. Bare when safe; double-quoted (with
// embedded quotes stripped) when it contains whitespace or cmd metacharacters.
function cmdArg(value) {
  const s = String(value).replaceAll("%", "%%");
  if (s.length && !/[\s"&|<>^()]/.test(s)) return s;
  return `"${s.replace(/"/g, "")}"`;
}

// POSIX single-quote: wrap in '...' and escape embedded single quotes as '\''.
function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Writes a throwaway launcher script that re-establishes the WEFT_* identity env *inside the new
// shell* and then execs copilot. This makes the hand-off immune to terminal brokers (Windows
// Terminal, Terminal.app, gnome-terminal-server) that spawn tabs under their own captured
// environment and would otherwise drop env vars we set on the launch process. Leaked into tmp like
// the identity file — the spawned session consumes it at startup and the OS reaps temp later.
function writeLauncherScript({ platform, identityFile, channelId, cwd, copilotArgs, copilotExecutable = "copilot" }) {
  const isWindows = platform === "win32";
  const file = join(tmpdir(), `weft-launch-${process.pid}-${randomUUID()}.${isWindows ? "cmd" : "sh"}`);
  let body;
  if (isWindows) {
    body =
      "@echo off\r\n" +
      "setlocal DisableDelayedExpansion\r\n" +
      `set "WEFT_IDENTITY_FILE=${cmdSetValue(identityFile)}"\r\n` +
      `set "WEFT_CHANNEL_ID=${cmdSetValue(channelId)}"\r\n` +
      `cd /d "${cmdSetValue(cwd)}"\r\n` +
      `${cmdArg(copilotExecutable)} ${copilotArgs.map(cmdArg).join(" ")}\r\n`;
  } else {
    body =
      "#!/bin/bash\n" +
      `export WEFT_IDENTITY_FILE=${shSingleQuote(identityFile)}\n` +
      `export WEFT_CHANNEL_ID=${shSingleQuote(channelId)}\n` +
      `cd ${shSingleQuote(cwd)}\n` +
      `exec ${shSingleQuote(copilotExecutable)} ${copilotArgs.map(shSingleQuote).join(" ")}\n`;
  }
  const fd = openSync(file, "wx", isWindows ? 0o600 : 0o700);
  try {
    writeFileSync(fd, body, "utf8");
  } finally {
    closeSync(fd);
  }
  return file;
}

function buildLaunch({ terminal, cwd, copilotArgs, identityFile, channelId, platform = process.platform, copilotExecutable = "copilot" }) {
  if (terminal === "windows-terminal") {
    // The launcher .cmd sets WEFT_* then runs copilot (which resolves through cmd's
    // PATHEXT — wt.exe alone can't, it hands the command straight to CreateProcess). Passing the
    // launcher path as a single argv element lets Node/wt quoting handle spaces in the path.
    const launcherFile = writeLauncherScript({ platform, identityFile, channelId, cwd, copilotArgs, copilotExecutable });
    return {
      command: "wt.exe",
      args: ["new-tab", "--startingDirectory", cwd, "cmd.exe", "/k", launcherFile],
      launcherFile,
    };
  }
  if (terminal === "windows-console") {
    const launcherFile = writeLauncherScript({ platform, identityFile, channelId, cwd, copilotArgs, copilotExecutable });
    const brokerFile = `${launcherFile}.broker.cmd`;
    writeFileSync(brokerFile, `@echo off\r\nstart "" "%ComSpec%" /d /k "${cmdSetValue(launcherFile)}"\r\n`, { flag: "wx", mode: 0o600 });
    return {
      command: process.env.ComSpec || "cmd.exe", args: ["/d", "/c", brokerFile],
      launcherFile, brokerFile,
    };
  }
  if (terminal === "macos-terminal") {
    const launcherFile = writeLauncherScript({ platform, identityFile, channelId, cwd, copilotArgs, copilotExecutable });
    const script = [
      "on run argv",
      "set launcher to item 1 of argv",
      "tell application \"Terminal\" to do script \"bash \" & quoted form of launcher",
      "end run",
    ].join("\n");
    return { command: "osascript", args: ["-e", script, launcherFile], launcherFile };
  }
  if (terminal === "gnome-terminal") {
    const launcherFile = writeLauncherScript({ platform, identityFile, channelId, cwd, copilotArgs, copilotExecutable });
    return { command: "gnome-terminal", args: [`--working-directory=${cwd}`, "--", "bash", launcherFile], launcherFile };
  }
  return { command: copilotExecutable, args: copilotArgs };
}
