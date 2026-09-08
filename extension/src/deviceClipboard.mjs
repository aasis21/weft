// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { CLIPBOARD_MAX_BYTES, clipboardTextError } from "@aasis21/weft-shared";

const PREFIX = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
`;
const READ_SCRIPT = PREFIX + String.raw`
if (-not [System.Windows.Forms.Clipboard]::ContainsText()) { exit 0 }
$text = [System.Windows.Forms.Clipboard]::GetText()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
if ($bytes.Length -gt 65536) { exit 3 }
[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
`;
const WRITE_SCRIPT = PREFIX + String.raw`
$text = [Console]::In.ReadToEnd()
if ([System.Text.Encoding]::UTF8.GetByteCount($text) -gt 65536) { exit 3 }
if ($text.Length -eq 0) {
  [System.Windows.Forms.Clipboard]::Clear()
} else {
  [System.Windows.Forms.Clipboard]::SetText($text)
}
`;

export function createDeviceClipboard({
  platform = process.platform,
  spawnFn = spawn,
  timeoutMs = 5_000,
} = {}) {
  let closed = false;
  let queue = Promise.resolve();
  const pending = new Set();

  function run(operation, text) {
    if (closed) return Promise.resolve({ code: "unavailable" });
    if (platform !== "win32") return Promise.resolve({ code: "unsupported" });
    if (operation === "write") {
      const code = clipboardTextError(text) ?? (text.includes("\0") ? "invalid-request" : null);
      if (code) return Promise.resolve({ code });
    }
    return new Promise((resolve) => {
      let child;
      let timer;
      let settled = false;
      let chunks = [];
      let size = 0;
      const finish = (code, kill = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(cancel);
        if (kill) {
          try { child?.kill(); } catch { /* already gone */ }
        }
        const result = code === "ok" && operation === "read"
          ? { code, text: Buffer.concat(chunks).toString("utf8") }
          : { code };
        chunks = [];
        resolve(result);
      };
      const cancel = () => finish("unavailable", true);
      pending.add(cancel);
      timer = setTimeout(() => finish("timeout", true), timeoutMs);
      try {
        child = spawnFn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-STA", "-Command", operation === "read" ? READ_SCRIPT : WRITE_SCRIPT],
          { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
        );
        child.on("error", () => finish("unavailable", true));
        child.stdin.on("error", () => finish("unavailable", true));
        child.stdout.on("error", () => finish("unavailable", true));
        child.stdout.on("data", (chunk) => {
          if (settled) return;
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > CLIPBOARD_MAX_BYTES) return finish("too-large", true);
          if (operation === "read") chunks.push(bytes);
        });
        child.on("close", (code) => finish(code === 0 ? "ok" : code === 3 ? "too-large" : "unavailable"));
        child.stdin.end(operation === "write" ? Buffer.from(text, "utf8") : undefined);
      } catch {
        finish("unavailable", true);
      }
    });
  }

  function enqueue(operation, text) {
    const result = queue.then(() => run(operation, text));
    queue = result.then(() => {}, () => {});
    return result;
  }

  return {
    supported: platform === "win32",
    readText: () => enqueue("read"),
    writeText: (text) => enqueue("write", text),
    shutdown() {
      closed = true;
      for (const cancel of pending) cancel();
      return queue;
    },
  };
}
