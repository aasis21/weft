// SPDX-License-Identifier: Apache-2.0
// Keeps `devtunnel host` attached to the relay process even when the relay is killed too hard for
// its cleanup handlers to run. Windows has Job Objects for the perfect version of this, but Node
// has no built-in binding; this tiny same-runtime watchdog avoids adding a native dependency while
// still making the host self-terminate as soon as its relay owner disappears.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { isPidAlive } from "./registryFile.mjs";

const execFileAsync = promisify(execFile);
const PARENT_POLL_MS = 750;

function shouldUseShellForCommand(command) {
  if (process.platform !== "win32") return false;
  return /\.(?:cmd|bat)$/i.test(command) || (!/[\\/]/.test(command) && !/\.[a-z0-9]+$/i.test(command));
}

async function killProcessTreeByPid(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/pid", String(pid), "/t", "/f"]);
    } catch {
      // best-effort — process may have already exited.
    }
    return;
  }
  try {
    process.kill(-pid);
  } catch {
    // Most children here are not process-group leaders; fall back to the process itself.
  }
  try {
    process.kill(pid);
  } catch {
    // best-effort
  }
}

const [parentPidRaw, bin, tunnelId] = process.argv.slice(2);
const parentPid = Number(parentPidRaw);

if (!Number.isInteger(parentPid) || !bin || !tunnelId) {
  process.exit(1);
}

const host = spawn(bin, ["host", tunnelId], {
  stdio: ["ignore", "pipe", "pipe"],
  shell: shouldUseShellForCommand(bin),
});

host.stdout?.pipe(process.stdout);
host.stderr?.pipe(process.stderr);

let shuttingDown = false;
async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(parentPoll);
  await killProcessTreeByPid(host.pid);
  process.exitCode = exitCode;
}

const parentPoll = setInterval(() => {
  if (!isPidAlive(parentPid)) void shutdown(0);
}, PARENT_POLL_MS);

host.once("error", () => void shutdown(1));
host.once("close", (code) => {
  clearInterval(parentPoll);
  process.exitCode = code ?? 0;
});

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => void shutdown(0));
}
