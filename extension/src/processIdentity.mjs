// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isPidAlive } from "./registryFile.mjs";

const execFileAsync = promisify(execFile);

function validPid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("pid must be a positive safe integer");
  return pid;
}

export async function getProcessStartTime(
  pid,
  { platform = process.platform, exec = execFileAsync } = {},
) {
  validPid(pid);
  let command;
  let args;
  if (platform === "win32") {
    command = "powershell.exe";
    args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p=Get-Process -Id ${pid} -ErrorAction Stop; ` +
        `[DateTimeOffset]::new($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`,
    ];
  } else {
    command = "ps";
    args = ["-o", "lstart=", "-p", String(pid)];
  }
  const { stdout } = await exec(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  const value = platform === "win32" ? Number(stdout.trim()) : Date.parse(stdout.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Unable to determine process start time for PID ${pid}`);
  }
  return value;
}

export async function verifyProcessIdentity(
  { pid, processStartedAt },
  {
    isAlive = isPidAlive,
    getStartTime = getProcessStartTime,
    toleranceMs = 2_000,
  } = {},
) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(processStartedAt) || processStartedAt <= 0) {
    return { live: false, reason: "invalid-process-identity" };
  }
  if (!isAlive(pid)) return { live: false, reason: "process-exited" };
  try {
    const actualStartedAt = await getStartTime(pid);
    if (Math.abs(actualStartedAt - processStartedAt) > toleranceMs) {
      return { live: false, reason: "pid-reused", actualStartedAt };
    }
    return { live: true, actualStartedAt };
  } catch (error) {
    return { live: null, reason: "process-unverifiable", error };
  }
}
