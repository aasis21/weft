// SPDX-License-Identifier: Apache-2.0
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import {
  createControlServer as createLifecycleEndpoint,
  controlAuth as lifecycleAuth,
  controlEndpointAddress as runtimeEndpointAddress,
  sendControlCommand as sendLifecycleCommand,
  createControlIdentity as createRuntimeIdentity,
} from "./sessionControl.mjs";
import { appendStationLog } from "./stationLog.mjs";
import { getProcessStartTime, verifyProcessIdentity } from "./processIdentity.mjs";
import { clearRegistry, isPidAlive, readRegistry, writeRegistryAtomic } from "./registryFile.mjs";
import { weftHome } from "./projects.mjs";
import { resolveVersion } from "./version.mjs";

const execFileAsync = promisify(execFile);
const BACKGROUND_ROLES = new Set(["station", "relay"]);

// How the Windows background workloads run
// -----------------------------------------
// Station and the relay each run as ONE Windows Task Scheduler task per user and Weft home. The
// task has no triggers: Start runs it once, and that single run lasts until Stop. Task Scheduler
// only provides a hidden process under the user's account that outlives the terminal or dashboard.
//
// The task runs a small PowerShell "supervisor" loop, which runs the Node worker
// (`weft __background-worker <role> <home>`) and restarts it after a crash:
//   - restart delay starts at 1 second and doubles up to 30 seconds;
//   - a run that lasted at least 60 seconds counts as healthy and resets the delay;
//   - each crash is recorded in background-<role>-restarts.json so status can report a worker that
//     keeps crashing ("crash loop") instead of silently retrying forever;
//   - the worker records its own fatal error in background-<role>-failure.json before exiting.
// Stop disables the task and writes a stop marker first, so the loop can never restart a worker
// that is being stopped deliberately.
export const RESTART_DELAY_INITIAL_MS = 1_000;
export const RESTART_DELAY_MAX_MS = 30_000;
export const HEALTHY_RUN_SECONDS = 60;
// Five crashes in a row, each within a minute of starting, is reported as "crashing repeatedly".
export const REPEATED_CRASH_THRESHOLD = 5;
// Crash information older than this (the longest retry wait plus a quick run) is no longer current.
const CRASH_REPORT_WINDOW_MS = 2 * 60_000;
// Task Scheduler last-result codes that do not mean the workload failed.
const TASK_RESULT_SUCCESS = 0;
const TASK_RESULT_NOT_RUN_YET = 0x41303;

function requireRole(role) {
  if (!BACKGROUND_ROLES.has(role)) throw new Error("Background role must be station or relay.");
  return role;
}

/** Registry published by a running worker: its authenticated local control endpoint. */
function controlRegistryFileName(role) {
  return `background-${requireRole(role)}.json`;
}

/** Written by the supervisor loop after every crash. */
export function restartStateFileName(role) {
  return `background-${requireRole(role)}-restarts.json`;
}

/** Written by the worker itself just before it exits on a fatal error. */
export function workerFailureFileName(role) {
  return `background-${requireRole(role)}-failure.json`;
}

function stopMarkerPath(role, baseDir) {
  return join(resolve(baseDir), `background-${requireRole(role)}.stop`);
}

export function backgroundTaskName(role, { baseDir = weftHome(), platform = process.platform } = {}) {
  const resolvedHome = resolve(baseDir);
  const homeIdentity = platform === "win32" ? resolvedHome.toLowerCase() : resolvedHome;
  const homeHash = createHash("sha256").update(homeIdentity).digest("hex").slice(0, 16);
  return `Weft-${requireRole(role)}-${homeHash}`;
}

/**
 * Installation identity: the installed CLI folder plus the build version. The task definition and
 * the running worker both report it, so `ensureStationRunning` can tell a worker running older code
 * or another installation from one running exactly what is installed.
 */
export function backgroundInstallId({ cliPath, version = resolveVersion(), platform = process.platform } = {}) {
  if (!cliPath) return null;
  const paths = platform === "win32" ? win32 : posix;
  let path = paths.resolve(cliPath);
  if (platform === process.platform) {
    try { path = realpathSync(path); } catch { /* A missing path still identifies the install. */ }
  }
  const folder = paths.dirname(path);
  return createHash("sha256").update(`${platform === "win32" ? folder.toLowerCase() : folder}\n${version}`)
    .digest("hex").slice(0, 16);
}

/** Quote a value as a single-quoted PowerShell literal (no interpolation). */
function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** The PowerShell loop that the scheduled task runs. See the overview at the top of this file. */
export function backgroundSupervisorScript({
  role, baseDir = weftHome(), cliPath, nodePath = process.execPath,
  restartDelayInitialMs = RESTART_DELAY_INITIAL_MS, restartDelayMaxMs = RESTART_DELAY_MAX_MS,
  healthyRunSeconds = HEALTHY_RUN_SECONDS,
} = {}) {
  requireRole(role);
  return `$ErrorActionPreference='Stop'
$nodeExecutable=${powerShellLiteral(nodePath)}
$weftCli=${powerShellLiteral(resolve(cliPath))}
$weftHome=${powerShellLiteral(resolve(baseDir))}
$workerRole=${powerShellLiteral(role)}
$weftInstallId=${powerShellLiteral(backgroundInstallId({ cliPath }) ?? "")}
$stopMarkerPath=${powerShellLiteral(stopMarkerPath(role, baseDir))}
$restartStatePath=${powerShellLiteral(win32.join(resolve(baseDir), restartStateFileName(role)))}
$restartDelayInitialMs=${Number(restartDelayInitialMs)}
$restartDelayMaxMs=${Number(restartDelayMaxMs)}
$healthyRunSeconds=${Number(healthyRunSeconds)}
$restartDelayMs=$restartDelayInitialMs
$totalCrashes=0
$quickCrashesInARow=0
$quickCrashStreakStartedAt=$null
while ($true) {
  if (Test-Path -LiteralPath $stopMarkerPath) { exit 0 }
  $workerStartedAt=[DateTime]::UtcNow
  $ErrorActionPreference='Continue'
  $global:LASTEXITCODE=1
  & $nodeExecutable $weftCli '__background-worker' $workerRole $weftHome > $null 2> $null
  $workerExitCode=$LASTEXITCODE
  $ErrorActionPreference='Stop'
  if ($workerExitCode -eq 0) { exit 0 }
  if (Test-Path -LiteralPath $stopMarkerPath) { exit 0 }
  # The worker crashed. Record it so status can explain repeated failures, then wait and retry.
  $workerRunSeconds=([DateTime]::UtcNow-$workerStartedAt).TotalSeconds
  $crashedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $totalCrashes++
  if ($workerRunSeconds -ge $healthyRunSeconds) {
    $restartDelayMs=$restartDelayInitialMs
    $quickCrashesInARow=0
    $quickCrashStreakStartedAt=$null
  } else {
    if ($quickCrashesInARow -eq 0) { $quickCrashStreakStartedAt=$crashedAt }
    $quickCrashesInARow++
  }
  $restartState=@{
    role=$workerRole; totalCrashes=$totalCrashes; quickCrashesInARow=$quickCrashesInARow
    quickCrashStreakStartedAt=$quickCrashStreakStartedAt; lastExitCode=$workerExitCode
    lastCrashAt=$crashedAt; lastRunSeconds=[Math]::Round($workerRunSeconds,1); nextRestartAt=$crashedAt+$restartDelayMs
  } | ConvertTo-Json -Compress
  try {
    [IO.File]::WriteAllText("$restartStatePath.tmp",$restartState)
    Move-Item -LiteralPath "$restartStatePath.tmp" -Destination $restartStatePath -Force
  } catch { }
  Start-Sleep -Milliseconds $restartDelayMs
  $restartDelayMs=[Math]::Min($restartDelayMaxMs,$restartDelayMs*2)
}`;
}

/** PowerShell that inspects or changes the scheduled task: start, disable, stop or status. */
export function backgroundTaskScript(operation, {
  role, baseDir = weftHome(), cliPath, nodePath = process.execPath,
} = {}) {
  if (!["start", "disable", "stop", "status"].includes(operation)) throw new Error("Invalid background task operation.");
  const taskName = backgroundTaskName(role, { baseDir });
  const supervisorScript = backgroundSupervisorScript({ role, baseDir, cliPath, nodePath });
  const supervisorArguments = "-NoLogo -NoProfile -NonInteractive -EncodedCommand " +
    Buffer.from(supervisorScript, "utf16le").toString("base64");
  const powerShellExecutable = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Every operation first finds the task and refuses to touch one owned by another Windows user.
  const findTaskAndCheckOwner = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$taskName=${powerShellLiteral(taskName)}
$stopMarkerPath=${powerShellLiteral(stopMarkerPath(role, baseDir))}
$currentUserSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$existingTask=Get-ScheduledTask -TaskPath '\\' | Where-Object { $_.TaskName -eq $taskName }
if ($existingTask) {
  $taskOwnerSid=[string]$existingTask.Principal.UserId
  if ($taskOwnerSid -notmatch '^S-\\d+-') {
    $taskOwnerSid=([Security.Principal.NTAccount]$taskOwnerSid).Translate([Security.Principal.SecurityIdentifier]).Value
  }
  if ($taskOwnerSid -ne $currentUserSid) { throw 'The Weft task belongs to another identity; no changes were made.' }
}
`;
  if (operation === "status") {
    return `${findTaskAndCheckOwner}
if ($existingTask) {
  $lastTaskResult=$null
  try { $lastTaskResult=[int64](Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\\').LastTaskResult } catch { }
  $taskInstallId=$null
  if ([string]$existingTask.Description -match 'installId=([0-9a-f]+)') { $taskInstallId=$Matches[1] }
  @{state=[string]$existingTask.State; taskName=$taskName; lastResult=$lastTaskResult; installId=$taskInstallId} | ConvertTo-Json -Compress
}
else { @{state='NotRegistered'; taskName=$taskName} | ConvertTo-Json -Compress }`;
  }
  if (operation === "disable" || operation === "stop") {
    // Disable and write the stop marker BEFORE stopping, so the supervisor cannot restart the worker.
    return `${findTaskAndCheckOwner}
if ($existingTask) {
  Disable-ScheduledTask -TaskName $taskName -TaskPath '\\' | Out-Null
  [IO.File]::WriteAllText($stopMarkerPath,'stopped')
  ${operation === "stop" ? `Stop-ScheduledTask -TaskName $taskName -TaskPath '\\'
  $stopDeadline=[DateTime]::UtcNow.AddSeconds(10)
  do {
    $currentTask=Get-ScheduledTask -TaskName $taskName -TaskPath '\\'
    if ([string]$currentTask.State -ne 'Running') { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $stopDeadline)
  if ([string]$currentTask.State -eq 'Running') { throw 'Weft did not stop; no stopped status was reported.' }` : ""}
}
@{state='${operation === "stop" ? "Stopped" : "Disabled"}'; taskName=$taskName} | ConvertTo-Json -Compress`;
  }
  // start: run the task once. An already-running task from this installation is left alone.
  return `${findTaskAndCheckOwner}
$actionExecutable=${powerShellLiteral(powerShellExecutable)}
$actionArguments=${powerShellLiteral(supervisorArguments)}
if (Test-Path -LiteralPath $stopMarkerPath) { Remove-Item -LiteralPath $stopMarkerPath -Force }
if ($existingTask -and ([string]$existingTask.State -eq 'Running')) {
  if ($existingTask.Actions.Count -ne 1 -or $existingTask.Actions[0].Execute -ne $actionExecutable -or $existingTask.Actions[0].Arguments -ne $actionArguments) {
    throw 'Weft is already running from a different installation or an earlier Weft version. Run weft stop, then start again.'
  }
} else {
  # A fresh start clears crash information from the previous run.
  foreach ($previousRunFile in @(${powerShellLiteral(win32.join(resolve(baseDir), restartStateFileName(role)))}, ${powerShellLiteral(win32.join(resolve(baseDir), workerFailureFileName(role)))})) {
    if (Test-Path -LiteralPath $previousRunFile) { Remove-Item -LiteralPath $previousRunFile -Force }
  }
  $taskAction=New-ScheduledTaskAction -Execute $actionExecutable -Argument $actionArguments
  $taskPrincipal=New-ScheduledTaskPrincipal -UserId $currentUserSid -LogonType Interactive -RunLevel Limited
  $taskSettings=New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
  $taskDefinition=New-ScheduledTask -Action $taskAction -Principal $taskPrincipal -Settings $taskSettings -Description ${powerShellLiteral(`Manually started Weft background workload. No boot or sign-in triggers. installId=${backgroundInstallId({ cliPath }) ?? "unknown"}`)}
  Register-ScheduledTask -TaskName $taskName -TaskPath '\\' -InputObject $taskDefinition -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName -TaskPath '\\'
}
@{state='Starting'; taskName=$taskName} | ConvertTo-Json -Compress`;
}

function launchAgentPath(role, baseDir) {
  return join(resolve(baseDir), `background-${requireRole(role)}.plist`);
}

function launchDomain(uid = process.getuid?.()) {
  if (!Number.isInteger(uid) || uid < 0) throw new Error("A logged-in macOS user session is required for background workloads.");
  return `gui/${uid}`;
}

function xmlText(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/** Per-user launchd job. It is stored under ~/.weft, not ~/Library/LaunchAgents, so it is never
 * loaded automatically at sign-in. RunAtLoad is also false: registration alone does not start it. */
export function backgroundLaunchAgentPlist({
  role, baseDir = weftHome(), cliPath, nodePath = process.execPath,
} = {}) {
  requireRole(role);
  if (!cliPath || !isAbsolute(cliPath)) throw new Error("An absolute Weft CLI path is required.");
  const label = backgroundTaskName(role, { baseDir, platform: "darwin" });
  const values = [nodePath, resolve(cliPath), "__background-supervisor", role, resolve(baseDir)];
  const argumentsXml = values.map((value) => `<string>${xmlText(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xmlText(label)}</string>
<key>ProgramArguments</key><array>${argumentsXml}</array>
<key>RunAtLoad</key><false/>
<key>KeepAlive</key><false/>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
<key>EnvironmentVariables</key><dict><key>WEFT_HOME</key><string>${xmlText(resolve(baseDir))}</string><key>WEFT_INSTALL_ID</key><string>${xmlText(backgroundInstallId({ cliPath }))}</string></dict>
</dict></plist>
`;
}

function writeLaunchAgent(role, options) {
  const path = launchAgentPath(role, options.baseDir);
  const content = backgroundLaunchAgentPlist({ ...options, role });
  mkdirSync(resolve(options.baseDir), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  try {
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return { path, content };
}

function isMissingLaunchService(error) {
  return /could not find service|service not found|no such process/i.test(
    `${error?.stderr ?? ""}\n${error?.stdout ?? ""}\n${error?.message ?? ""}`,
  );
}

async function launchdStatus(role, options, exec) {
  const label = backgroundTaskName(role, { ...options, platform: "darwin" });
  const domain = launchDomain(options.uid);
  try {
    const { stdout } = await exec("launchctl", ["print", `${domain}/${label}`], {
      encoding: "utf8", timeout: 30_000,
    });
    const stateMatch = /^\s*state\s*=\s*(.+?)\s*$/mi.exec(stdout);
    if (!stateMatch) throw new Error("launchctl returned an invalid Weft status.");
    const stateName = stateMatch[1].toLowerCase();
    const state = stateName === "running" ? "Running"
      : ["waiting", "not running", "spawn scheduled"].includes(stateName) ? "Ready" : null;
    if (!state) throw new Error("launchctl returned an unknown Weft workload state.");
    const exitMatch = /^\s*last exit code\s*=\s*(-?\d+)\s*$/mi.exec(stdout);
    let installId = null;
    try {
      installId = /<key>WEFT_INSTALL_ID<\/key><string>([0-9a-f]+)<\/string>/.exec(
        readFileSync(launchAgentPath(role, options.baseDir ?? weftHome()), "utf8"))?.[1] ?? null;
    } catch { /* A missing job file has no installation identity. */ }
    return {
      state, taskName: label,
      lastResult: exitMatch ? Number(exitMatch[1]) : null,
      installId,
    };
  } catch (error) {
    if (isMissingLaunchService(error)) return { state: "NotRegistered", taskName: label, lastResult: null };
    throw new Error(`Weft background status failed: ${error.message}`, { cause: error });
  }
}

async function launchdOperation(operation, options, exec) {
  const { role, baseDir = weftHome() } = options;
  requireRole(role);
  const label = backgroundTaskName(role, { ...options, baseDir, platform: "darwin" });
  const domain = launchDomain(options.uid);
  const target = `${domain}/${label}`;
  const path = launchAgentPath(role, baseDir);
  if (operation === "status") return launchdStatus(role, { ...options, baseDir }, exec);
  if (operation === "disable") {
    mkdirSync(resolve(baseDir), { recursive: true, mode: 0o700 });
    writeFileSync(stopMarkerPath(role, baseDir), "stopped", { mode: 0o600 });
    return { state: "Disabled", taskName: label };
  }
  if (operation === "stop") {
    const current = await launchdStatus(role, { ...options, baseDir }, exec);
    if (current.state !== "NotRegistered") {
      try {
        await exec("launchctl", ["bootout", target], { encoding: "utf8", timeout: 30_000 });
      } catch (error) {
        if (!isMissingLaunchService(error)) throw new Error(`Weft background stop failed: ${error.message}`, { cause: error });
      }
    }
    rmSync(path, { force: true });
    return { state: "Stopped", taskName: label };
  }
  if (operation !== "start") throw new Error("Invalid background task operation.");
  const current = await launchdStatus(role, { ...options, baseDir }, exec);
  const desired = backgroundLaunchAgentPlist({ ...options, role, baseDir });
  if (current.state === "NotRegistered") {
    writeLaunchAgent(role, { ...options, role, baseDir });
    await exec("launchctl", ["bootstrap", domain, path], { encoding: "utf8", timeout: 30_000 });
  } else {
    let installed;
    try { installed = readFileSync(path, "utf8"); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (installed !== desired) {
      throw new Error("Weft is already registered from a different installation or earlier version. Run `weft stop`, then start again.");
    }
  }
  rmSync(stopMarkerPath(role, baseDir), { force: true });
  if (current.state !== "Running") {
    clearRegistry(restartStateFileName(role), { baseDir });
    clearRegistry(workerFailureFileName(role), { baseDir });
    await exec("launchctl", ["kickstart", target], { encoding: "utf8", timeout: 30_000 });
  }
  return { state: "Starting", taskName: label };
}

const EXIT_CODE_MEANINGS = new Map([
  [1, "Weft exited because of an error."],
  [0xC000013A, "The worker's console was interrupted or closed (Ctrl+C, console close or Windows sign-out)."],
  [0xC0000005, "Native crash: access violation."],
  [0xC00000FD, "Native crash: stack overflow."],
  [0xC0000409, "Native crash: the process stopped itself after detecting a fatal error."],
  [0xC0000142, "Windows could not initialize the process, often because the session is ending."],
  [0x41306, "Task Scheduler terminated the task."],
]);

/** Exit code as Windows shows it (hex for status codes) plus a plain-English meaning. */
export function describeExitCode(exitCode) {
  if (!Number.isInteger(exitCode)) return { code: "unknown", meaning: "No exit code was reported." };
  const unsigned = exitCode >>> 0;
  return {
    code: unsigned > 0xFFFF ? "0x" + unsigned.toString(16).toUpperCase() : String(unsigned),
    meaning: EXIT_CODE_MEANINGS.get(unsigned) ?? "The worker exited with an unexpected code.",
  };
}

/** A safe, one-line summary of a fatal worker error: no stack, credentials or addresses. */
export function summarizeWorkerError(error) {
  const text = (value, limit) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/https?:\/\/\S+|wss?:\/\/\S+/gi, "[address]")
    .replace(/\b(Bearer|token|secret|password|api[-_]?key)(\s*[:= ]\s*)\S+/gi, "$1$2[redacted]")
    .trim().slice(0, limit);
  const firstLine = String(error?.message ?? error ?? "Unknown error").split(/\r?\n/)[0];
  const frame = String(error?.stack ?? "").split(/\r?\n/).slice(1)
    .map((line) => /\(?([^()\s]+?):(\d+):\d+\)?\s*$/.exec(line.trim())).find(Boolean);
  return {
    name: text(error?.name ?? "Error", 60) || "Error",
    code: typeof error?.code === "string" || Number.isInteger(error?.code) ? text(error.code, 60) : null,
    message: text(firstLine, 500) || "Unknown error",
    location: frame ? `${text(frame[1].split(/[\\/]/).pop(), 80)}:${frame[2]}` : null,
  };
}

function recordedFailure(role, baseDir) {
  const failure = readRegistry(workerFailureFileName(role), { baseDir });
  return failure && typeof failure.message === "string"
    ? { name: failure.name ?? "Error", code: failure.code ?? null, message: failure.message, location: failure.location ?? null, at: failure.at ?? null }
    : null;
}

/**
 * Current crash information for a worker, or null when it has not crashed recently or has since
 * stayed up for a healthy run. `repeated` means it keeps crashing within a minute of starting.
 */
export function readWorkerCrashReport(role, { baseDir = weftHome(), now = Date.now(), workerStartedAt = null } = {}) {
  const restarts = readRegistry(restartStateFileName(role), { baseDir });
  if (!restarts || !Number.isFinite(restarts.lastCrashAt) || now - restarts.lastCrashAt > CRASH_REPORT_WINDOW_MS) return null;
  const recoveredSince = Number.isFinite(workerStartedAt) && workerStartedAt > restarts.lastCrashAt &&
    now - workerStartedAt >= HEALTHY_RUN_SECONDS * 1000;
  if (recoveredSince) return null;
  const failure = recordedFailure(role, baseDir);
  const quickCrashesInARow = Number.isInteger(restarts.quickCrashesInARow) ? restarts.quickCrashesInARow : 0;
  return {
    repeated: quickCrashesInARow >= REPEATED_CRASH_THRESHOLD,
    quickCrashesInARow,
    totalCrashes: Number.isInteger(restarts.totalCrashes) ? restarts.totalCrashes : null,
    streakStartedAt: Number.isFinite(restarts.quickCrashStreakStartedAt) ? restarts.quickCrashStreakStartedAt : null,
    lastCrashAt: restarts.lastCrashAt,
    lastRunSeconds: Number.isFinite(restarts.lastRunSeconds) ? restarts.lastRunSeconds : null,
    nextRestartAt: Number.isFinite(restarts.nextRestartAt) ? restarts.nextRestartAt : null,
    exit: describeExitCode(restarts.lastExitCode),
    signal: typeof restarts.lastSignal === "string" ? restarts.lastSignal : null,
    // The worker writes its failure just before exiting, so only a record from this crash applies.
    lastError: failure && Math.abs(restarts.lastCrashAt - (failure.at ?? 0)) < CRASH_REPORT_WINDOW_MS ? failure : null,
  };
}

/** When the whole task ended without `weft stop`: its exit code, meaning and last recorded error. */
export function readUnexpectedTaskExit(role, task, { baseDir = weftHome() } = {}) {
  // Weft stop disables the task, so an enabled, idle task with a failure result ended on its own.
  if (task?.state !== "Ready" || !Number.isInteger(task.lastResult) ||
      [TASK_RESULT_SUCCESS, TASK_RESULT_NOT_RUN_YET].includes(task.lastResult)) return null;
  return { exit: describeExitCode(task.lastResult), lastError: recordedFailure(role, baseDir) };
}

/** Plain-language summary used by both the dashboard and `weft status`. */
export function describeWorkerProblem(role, { crash = null, unexpectedStop = null } = {}) {
  const label = role === "station" ? "Station" : "The relay";
  const detail = (report) => (report.signal ? `signal ${report.signal}` : `exit code ${report.exit.code}: ${report.exit.meaning}`) +
    (report.lastError ? ` Last error: ${report.lastError.name}: ${report.lastError.message}` +
      (report.lastError.location ? ` (${report.lastError.location})` : "") : "");
  if (crash?.repeated) return `${label} is crashing repeatedly: ${crash.quickCrashesInARow} crashes in a row, each within a minute of starting (${detail(crash)}). Weft keeps retrying every 30 seconds or less; fix the cause, then restart it.`;
  if (unexpectedStop) return `${label} stopped unexpectedly (${detail(unexpectedStop)}). Start it again; saved phone trust is unchanged.`;
  if (crash) return `${label} crashed and was restarted (${detail(crash)}).`;
  return null;
}

export async function backgroundTaskOperation(operation, options, { exec = execFileAsync } = {}) {
  if ((options.platform ?? process.platform) === "darwin") {
    return launchdOperation(operation, options, exec);
  }
  const script = backgroundTaskScript(operation, options);
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  let stdout;
  try {
    ({ stdout } = await exec("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded,
    ], { windowsHide: true, encoding: "utf8", timeout: 30_000 }));
  } catch (error) {
    const detail = /<S S="Error">([^<]+)/.exec(error.stderr ?? "")?.[1]
      ?.split("_x000D_")[0]?.replaceAll("&amp;", "&")?.replaceAll("&lt;", "<")?.replaceAll("&gt;", ">");
    throw new Error(`Weft background ${operation} failed: ${detail || "Task Scheduler could not complete the operation. Check task permissions."}`, { cause: error });
  }
  const result = JSON.parse(stdout.trim());
  if (typeof result?.state !== "string" || typeof result?.taskName !== "string") {
    throw new Error("Task Scheduler returned an invalid Weft status.");
  }
  return result;
}

/** Run the same bounded-retry worker loop on macOS that the Windows task supervisor runs. */
export async function runBackgroundSupervisor(role, baseDir, {
  cliPath, nodePath = process.execPath, spawnWorker = spawn,
  restartDelayInitialMs = RESTART_DELAY_INITIAL_MS, restartDelayMaxMs = RESTART_DELAY_MAX_MS,
  healthyRunSeconds = HEALTHY_RUN_SECONDS, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  requireRole(role);
  if (!baseDir || !isAbsolute(baseDir) || !cliPath || !isAbsolute(cliPath)) {
    throw new Error("Invalid background supervisor invocation.");
  }
  const home = resolve(baseDir);
  const marker = stopMarkerPath(role, home);
  let stopping = false;
  let activeChild = null;
  let activeExit = null;
  let stopTask = null;
  const requestStop = () => {
    if (stopTask) return stopTask;
    stopping = true;
    try { writeFileSync(marker, "stopped", { mode: 0o600 }); }
    catch (error) {
      process.exitCode = 1;
      appendStationLog("supervisor.stop_marker_failed", { role, code: error.code ?? error.name }, { baseDir: home, level: "error" });
    }
    stopTask = (async () => {
      const child = activeChild;
      const exited = activeExit;
      if (!child || !exited) return;
      try {
        const reply = await backgroundCommand(role, "quiesce", null, { baseDir: home, timeoutMs: 2_000 });
        if (!reply) child.kill("SIGTERM");
      } catch (error) {
        appendStationLog("supervisor.quiesce_failed", { role, code: error.code ?? error.name }, { baseDir: home, level: "warn" });
        child.kill("SIGTERM");
      }
      let timeout;
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise((resolveStop) => { timeout = setTimeout(() => resolveStop(false), 10_000); }),
      ]);
      clearTimeout(timeout);
      if (!stopped) child.kill("SIGKILL");
    })();
    return stopTask;
  };
  const handleSignal = () => { void requestStop(); };
  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
  let restartDelayMs = restartDelayInitialMs;
  let totalCrashes = 0;
  let quickCrashesInARow = 0;
  let quickCrashStreakStartedAt = null;
  try {
    while (!stopping) {
      if (existsSync(marker)) return 0;
      const workerStartedAt = now();
      const child = spawnWorker(nodePath, [resolve(cliPath), "__background-worker", role, home], {
        stdio: "ignore", windowsHide: true, env: { ...process.env, WEFT_HOME: home },
      });
      activeChild = child;
      activeExit = new Promise((resolveExit) => {
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          resolveExit(result);
        };
        child.once("error", (error) => finish({ code: 1, error }));
        child.once("exit", (code, signal) => finish({ code, signal }));
      });
      const exit = await activeExit;
      activeChild = null;
      activeExit = null;
      if (stopping || existsSync(marker)) {
        await stopTask;
        return 0;
      }
      if (exit.code === 0) return 0;
      const crashedAt = now();
      const workerRunSeconds = (crashedAt - workerStartedAt) / 1000;
      if (exit.error) {
        writeRegistryAtomic(workerFailureFileName(role), {
          at: crashedAt, ...summarizeWorkerError(exit.error),
        }, { baseDir: home });
      }
      totalCrashes++;
      if (workerRunSeconds >= healthyRunSeconds) {
        restartDelayMs = restartDelayInitialMs;
        quickCrashesInARow = 0;
        quickCrashStreakStartedAt = null;
      } else {
        if (quickCrashesInARow === 0) quickCrashStreakStartedAt = crashedAt;
        quickCrashesInARow++;
      }
      writeRegistryAtomic(restartStateFileName(role), {
        role, totalCrashes, quickCrashesInARow, quickCrashStreakStartedAt,
        lastExitCode: exit.code, lastSignal: exit.signal ?? null, lastCrashAt: crashedAt,
        lastRunSeconds: Math.round(workerRunSeconds * 10) / 10,
        nextRestartAt: crashedAt + restartDelayMs,
      }, { baseDir: home });
      await sleep(restartDelayMs);
      restartDelayMs = Math.min(restartDelayMaxMs, restartDelayMs * 2);
    }
    await stopTask;
    return 0;
  } finally {
    process.removeListener("SIGTERM", handleSignal);
    process.removeListener("SIGINT", handleSignal);
  }
}

export async function backgroundCommand(role, command = "status", payload = null, {
  baseDir = weftHome(), request = sendLifecycleCommand, timeoutMs = 2_000,
} = {}) {
  const record = readRegistry(controlRegistryFileName(role), { baseDir });
  if (!record) return null;
  if (
    record.role !== role ||
    record.identity?.sessionId !== role ||
    typeof record.capability !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.capability) ||
    record.endpoint !== runtimeEndpointAddress(record.identity?.runtimeInstanceId, { baseDir })
  ) throw new Error("The background control registry is invalid. No process was contacted.");
  let response;
  try {
    response = await request({
      endpoint: record.endpoint,
      auth: lifecycleAuth(record.identity, record.capability),
      command, payload,
    }, { timeoutMs });
  } catch (error) {
    if (error?.timeout || ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(error?.code)) return null;
    throw error;
  }
  if (response?.ok !== true) throw new Error(response?.error?.message ?? "Background control failed.");
  return response.result;
}

/**
 * Start the role's task (a no-op if it is already running) and wait until the worker reports ready
 * over its authenticated control endpoint. A slow or busy worker is polled again, not failed.
 * `localTimeoutMs` bounds how long the worker may stay silent on its local pipe. With
 * `allowNetworkPending`, a worker that answers locally but is still connecting when `timeoutMs`
 * ends is returned with `networkPending: true` instead of failing.
 */
export async function startBackground(role, options, {
  taskOperation = backgroundTaskOperation,
  inspect = () => backgroundCommand(role, "status", null, options),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = 180_000,
  localTimeoutMs = timeoutMs,
  allowNetworkPending = false,
  pollIntervalMs = 500,
  onProgress = null,
} = {}) {
  await taskOperation("start", { ...options, role });
  const startedAt = now();
  const readyDeadline = startedAt + timeoutMs;
  let lastStatus = null;
  while (now() < readyDeadline) {
    const workerStatus = await inspect();
    if (workerStatus) { lastStatus = workerStatus; onProgress?.(workerStatus); }
    if (["ready", "endpoint-refresh-needed"].includes(workerStatus?.state)) return workerStatus;
    if (workerStatus?.state === "failed") throw new Error(workerStatus.error ?? "Weft background startup failed.");
    if (!lastStatus && now() - startedAt >= localTimeoutMs) {
      throw new Error(`Weft ${role} did not answer locally within ${Math.round(localTimeoutMs / 1000)} seconds.`);
    }
    await sleep(pollIntervalMs);
  }
  if (allowNetworkPending && lastStatus) return { ...lastStatus, networkPending: true };
  throw new Error(`Weft ${role} has not become ready. Use \`weft ${role === "station" ? "status" : "devtunnel status"}\` to inspect it; no duplicate process was started.`);
}

/** The worker's published control record: its pid and process start time, or null. */
export function readBackgroundControlRecord(role, { baseDir = weftHome() } = {}) {
  const record = readRegistry(controlRegistryFileName(role), { baseDir });
  return Number.isSafeInteger(record?.pid) && record.pid > 0
    ? { pid: record.pid, processStartedAt: record.processStartedAt ?? null } : null;
}

/**
 * Stop a worker that no longer answers its pipe: disable restarts (stop marker), kill exactly the
 * recorded worker process after verifying its start time, confirm it exited, then stop the task.
 * A pid that was reused by another process is never signalled.
 */
export async function forceStopBackground(role, options, {
  taskOperation = backgroundTaskOperation,
  record = () => readBackgroundControlRecord(role, options),
  verify = verifyProcessIdentity,
  kill = (pid) => process.kill(pid),
  isAlive = isPidAlive,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = 10_000,
} = {}) {
  await taskOperation("disable", { ...options, role });
  const worker = record();
  let killed = null;
  if (worker) {
    const identity = await verify(worker);
    if (identity.live === true) {
      try { kill(worker.pid); killed = worker.pid; }
      catch (error) { if (error.code !== "ESRCH") throw error; }
      const deadline = now() + timeoutMs;
      while (killed && isAlive(killed) && now() < deadline) await sleep(100);
      if (killed && isAlive(killed)) throw new Error(`Weft ${role} worker (PID ${killed}) did not exit after it was stopped.`);
    }
  }
  await taskOperation("stop", { ...options, role });
  return { state: "stopped", graceful: false, killedPid: killed };
}

/**
 * Stop deliberately: disable the task first (so nothing restarts it), ask the worker to shut down
 * cleanly, then stop the task.
 */
export async function stopBackground(role, options, {
  taskOperation = backgroundTaskOperation,
  quiesce = () => backgroundCommand(role, "quiesce", null, options),
  inspect = () => backgroundCommand(role, "status", null, options),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = 10_000,
} = {}) {
  await taskOperation("disable", { ...options, role });
  let stoppedGracefully = false;
  let shutdownError = null;
  try {
    const shutdownAccepted = await quiesce();
    const shutdownDeadline = now() + timeoutMs;
    while (shutdownAccepted && now() < shutdownDeadline) {
      if (!(await inspect())) { stoppedGracefully = true; break; }
      await sleep(100);
    }
  } catch (failure) {
    shutdownError = failure.message;
  }
  await taskOperation("stop", { ...options, role });
  return { state: "stopped", graceful: stoppedGracefully, ...(shutdownError ? { error: shutdownError } : {}) };
}

export async function createBackgroundControl(role, {
  baseDir = weftHome(), status, stop, activate, traffic,
  getStartTime = getProcessStartTime,
  installId = backgroundInstallId({ cliPath: process.argv[1] }),
  onStopError = (error) => { console.error(`Weft background shutdown failed: ${error.message}`); process.exitCode = 1; },
} = {}) {
  requireRole(role);
  const identity = createRuntimeIdentity({
    storeAuthority: `weft-background:${backgroundTaskName(role, { baseDir })}`,
    sessionId: role,
  });
  const capability = randomBytes(32).toString("hex");
  const endpoint = runtimeEndpointAddress(identity.runtimeInstanceId, { baseDir });
  const processStartedAt = await getStartTime(process.pid);
  const host = await createLifecycleEndpoint({
    identity, capability, endpoint,
    presence: () => ({ ...identity, pid: process.pid, processStartedAt }),
    handlers: {
      status: async () => ({ ...await status(), pid: process.pid, startedAt: processStartedAt, version: resolveVersion(), installId }),
      ...(activate ? { activate } : {}),
      ...(traffic ? { traffic } : {}),
      quiesce: () => {
        // Let the authenticated reply complete before stopping the control endpoint itself.
        setTimeout(() => { void Promise.resolve().then(stop).catch(onStopError); }, 50);
        return { state: "stopping" };
      },
    },
  }, { connectionTimeoutMs: 60_000, keepAlive: true });
  if (!writeRegistryAtomic(controlRegistryFileName(role), {
    role, identity, capability, endpoint, pid: process.pid, processStartedAt,
  }, { baseDir })) {
    await host.close();
    throw new Error("Could not publish background control; startup was cancelled.");
  }
  return {
    async close() {
      if (readRegistry(controlRegistryFileName(role), { baseDir })?.identity?.runtimeInstanceId === identity.runtimeInstanceId) {
        clearRegistry(controlRegistryFileName(role), { baseDir });
      }
      await host.close();
    },
  };
}
