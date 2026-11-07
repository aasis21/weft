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

/** Verify a discovery snapshot with one Windows process query, not one shell per runtime. */
export async function verifyProcessIdentities(presences, {
  platform = process.platform, isAlive = isPidAlive, toleranceMs = 2_000,
  getStartTimes = async (pids) => {
    const script = `@(
Get-Process -Id @(${pids.join(",")}) -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    [pscustomobject]@{pid=$_.Id;startedAt=[DateTimeOffset]::new($_.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()}
  } catch { }
}
) | ConvertTo-Json -Compress`;
    const { stdout } = await execFileAsync("powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 5_000, encoding: "utf8" });
    const value = stdout.trim() ? JSON.parse(stdout) : [];
    return Array.isArray(value) ? value : [value];
  },
} = {}) {
  if (platform !== "win32") return Promise.all(presences.map((presence) => verifyProcessIdentity(presence, { isAlive, toleranceMs })));
  const eligible = presences.map((p) => Number.isSafeInteger(p.pid) && p.pid > 0 &&
    Number.isSafeInteger(p.processStartedAt) && p.processStartedAt > 0);
  const live = presences.map((p, index) => eligible[index] && isAlive(p.pid));
  const pids = [...new Set(presences.filter((_, index) => live[index]).map((p) => p.pid))];
  let times = [], error;
  if (pids.length) {
    try { times = await getStartTimes(pids); }
    catch (failure) { error = failure; }
  }
  const actual = new Map(times.filter((p) => Number.isSafeInteger(p?.pid) &&
    Number.isSafeInteger(p?.startedAt) && p.startedAt > 0).map((p) => [p.pid, p.startedAt]));
  return presences.map((p, index) => {
    if (!eligible[index]) return { live: false, reason: "invalid-process-identity" };
    if (!live[index]) return { live: false, reason: "process-exited" };
    const startedAt = actual.get(p.pid);
    if (startedAt === undefined) return isAlive(p.pid)
      ? { live: null, reason: "process-unverifiable", error }
      : { live: false, reason: "process-exited" };
    return Math.abs(startedAt - p.processStartedAt) > toleranceMs
      ? { live: false, reason: "pid-reused", actualStartedAt: startedAt }
      : { live: true, actualStartedAt: startedAt };
  });
}
