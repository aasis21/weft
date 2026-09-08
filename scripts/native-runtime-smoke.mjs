// SPDX-License-Identifier: Apache-2.0
// Copied into an isolated distribution by the tests; no workspace imports.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const require = createRequire(new URL("./weft.mjs", import.meta.url));
assert.equal(require.resolve("node-pty"), fileURLToPath(new URL("./node_modules/node-pty/lib/index.js", import.meta.url)));
const pty = require("node-pty");
const windows = process.platform === "win32";
const shell = windows ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "/bin/sh";
const terminal = pty.spawn(shell, windows ? ["-NoLogo", "-NoProfile"] : [], {
  cols: 80, rows: 24, cwd: process.cwd(),
  env: { ...process.env, WEFT_SMOKE_SUFFIX: "OK" }, useConpty: true, useConptyDll: windows,
});
const deadline = setTimeout(() => { terminal.kill(); process.exitCode = 1; }, 15_000);
let output = "";
let completed = false;
terminal.onData((data) => {
  output += data;
  if (!completed && output.includes("WEFT_NATIVE_" + "OK")) {
    completed = true;
    terminal.resize(101, 37);
    assert.equal(terminal.cols, 101);
    assert.equal(terminal.rows, 37);
    terminal.write("exit\r");
  }
});
terminal.onExit(({ exitCode }) => {
  clearTimeout(deadline);
  assert.ok(completed, "shell did not return expected output");
  assert.equal(exitCode, 0);
  // Match Station's pinned node-pty 1.1.0 ConPTY DLL idle-worker cleanup.
  if (windows) {
    terminal.kill();
    assert.equal(typeof terminal._agent?._conoutSocketWorker?.dispose, "function");
    terminal._agent._conoutSocketWorker.dispose();
  }
  console.log("isolated native PTY spawn/input/output/resize/close OK");
});
terminal.write(windows
  ? "[Console]::WriteLine('WEFT_NATIVE_' + $env:WEFT_SMOKE_SUFFIX)\r"
  : "printf 'WEFT_NATIVE_%s\\n' OK\r");
