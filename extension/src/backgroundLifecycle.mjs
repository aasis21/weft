// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { resolve, win32 } from "node:path";
import { promisify } from "node:util";
import {
  createLifecycleEndpoint,
  lifecycleAuth,
  runtimeEndpointAddress,
  sendLifecycleCommand,
} from "./lifecycleEndpoint.mjs";
import { createRuntimeIdentity } from "./runtimeIdentity.mjs";
import { getProcessStartTime } from "./processIdentity.mjs";
import { clearRegistry, readRegistry, writeRegistryAtomic } from "./registryFile.mjs";
import { weftHome } from "./projects.mjs";

const execFileAsync = promisify(execFile);
const roles = new Set(["station", "relay"]);

function requireRole(role) {
  if (!roles.has(role)) throw new Error("Background role must be station or relay.");
  return role;
}

function registryName(role) {
  return `background-${requireRole(role)}.json`;
}

export function backgroundTaskName(role, { baseDir = weftHome() } = {}) {
  const suffix = createHash("sha256").update(resolve(baseDir).toLowerCase()).digest("hex").slice(0, 16);
  return `Weft-${requireRole(role)}-${suffix}`;
}

function psString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function backgroundSupervisorScript({
  role, baseDir = weftHome(), cliPath, nodePath = process.execPath,
} = {}) {
  requireRole(role);
  return `$ErrorActionPreference='Stop'
$node=${psString(nodePath)}
$cli=${psString(resolve(cliPath))}
$weftHome=${psString(resolve(baseDir))}
$role=${psString(role)}
$stop=${psString(win32.join(resolve(baseDir), `background-${role}.stop`))}
$delay=1
while ($true) {
  if (Test-Path -LiteralPath $stop) { exit 0 }
  $started=[DateTime]::UtcNow
  $ErrorActionPreference='Continue'
  $global:LASTEXITCODE=1
  & $node $cli '__background-worker' $role $weftHome > $null 2> $null
  $code=$LASTEXITCODE
  $ErrorActionPreference='Stop'
  if ($code -eq 0) { exit 0 }
  if (Test-Path -LiteralPath $stop) { exit 0 }
  if (([DateTime]::UtcNow-$started).TotalSeconds -ge 60) { $delay=1 }
  Start-Sleep -Seconds $delay
  $delay=[Math]::Min(30,$delay*2)
}`;
}

export function backgroundTaskScript(operation, {
  role, baseDir = weftHome(), cliPath, nodePath = process.execPath,
} = {}) {
  if (!["start", "disable", "stop", "status"].includes(operation)) throw new Error("Invalid background task operation.");
  const name = backgroundTaskName(role, { baseDir });
  const supervisor = backgroundSupervisorScript({ role, baseDir, cliPath, nodePath });
  const args = "-NoLogo -NoProfile -NonInteractive -EncodedCommand " +
    Buffer.from(supervisor, "utf16le").toString("base64");
  const shell = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const prefix = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$name=${psString(name)}
$stop=${psString(win32.join(resolve(baseDir), `background-${role}.stop`))}
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$task=Get-ScheduledTask -TaskPath '\\' | Where-Object { $_.TaskName -eq $name }
if ($task) {
  $owner=[string]$task.Principal.UserId
  if ($owner -notmatch '^S-\\d+-') {
    $owner=([Security.Principal.NTAccount]$owner).Translate([Security.Principal.SecurityIdentifier]).Value
  }
  if ($owner -ne $user) { throw 'The Weft task belongs to another identity; no changes were made.' }
}
`;
  if (operation === "status") {
    return `${prefix}
if ($task) { @{state=[string]$task.State; taskName=$name} | ConvertTo-Json -Compress }
else { @{state='NotRegistered'; taskName=$name} | ConvertTo-Json -Compress }`;
  }
  if (operation === "disable" || operation === "stop") {
    return `${prefix}
if ($task) {
  Disable-ScheduledTask -TaskName $name -TaskPath '\\' | Out-Null
  [IO.File]::WriteAllText($stop,'stopped')
  ${operation === "stop" ? `Stop-ScheduledTask -TaskName $name -TaskPath '\\'
  $deadline=[DateTime]::UtcNow.AddSeconds(10)
  do {
    $current=Get-ScheduledTask -TaskName $name -TaskPath '\\'
    if ([string]$current.State -ne 'Running') { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  if ([string]$current.State -eq 'Running') { throw 'Weft did not stop; no stopped status was reported.' }` : ""}
}
@{state='${operation === "stop" ? "Stopped" : "Disabled"}'; taskName=$name} | ConvertTo-Json -Compress`;
  }
  return `${prefix}
$execute=${psString(shell)}
$arguments=${psString(args)}
if (Test-Path -LiteralPath $stop) { Remove-Item -LiteralPath $stop -Force }
if ($task -and ([string]$task.State -eq 'Running')) {
  if ($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ne $execute -or $task.Actions[0].Arguments -ne $arguments) {
    throw 'Weft is running from another installation. Stop it there before starting this one.'
  }
} else {
  $action=New-ScheduledTaskAction -Execute $execute -Argument $arguments
  $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
  $definition=New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description 'Manually started Weft background workload. No boot or sign-in triggers.'
  Register-ScheduledTask -TaskName $name -TaskPath '\\' -InputObject $definition -Force | Out-Null
  Start-ScheduledTask -TaskName $name -TaskPath '\\'
}
@{state='Starting'; taskName=$name} | ConvertTo-Json -Compress`;
}

export async function backgroundTaskOperation(operation, options, { exec = execFileAsync } = {}) {
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

export async function backgroundCommand(role, command = "status", payload = null, {
  baseDir = weftHome(), request = sendLifecycleCommand, timeoutMs = 2_000,
} = {}) {
  const record = readRegistry(registryName(role), { baseDir });
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
    if (["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(error?.code)) return null;
    throw error;
  }
  if (response?.ok !== true) throw new Error(response?.error?.message ?? "Background control failed.");
  return response.result;
}

export async function startBackground(role, options, {
  taskOperation = backgroundTaskOperation,
  inspect = () => backgroundCommand(role, "status", null, options),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = 180_000,
} = {}) {
  await taskOperation("start", { ...options, role });
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const status = await inspect();
    if (["ready", "endpoint-refresh-needed"].includes(status?.state)) return status;
    if (status?.state === "failed") throw new Error(status.error ?? "Weft background startup failed.");
    await sleep(500);
  }
  throw new Error(`Weft ${role} has not become ready. Use \`weft ${role === "station" ? "status" : "devtunnel status"}\` to inspect it; no duplicate process was started.`);
}

export async function stopBackground(role, options, {
  taskOperation = backgroundTaskOperation,
  quiesce = () => backgroundCommand(role, "quiesce", null, options),
  inspect = () => backgroundCommand(role, "status", null, options),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = 10_000,
} = {}) {
  // Disable first so a graceful exit or a racing failure cannot schedule another restart.
  await taskOperation("disable", { ...options, role });
  let graceful = false;
  let error = null;
  try {
    const reply = await quiesce();
    const deadline = now() + timeoutMs;
    while (reply && now() < deadline) {
      if (!(await inspect())) { graceful = true; break; }
      await sleep(100);
    }
  } catch (failure) {
    error = failure.message;
  }
  await taskOperation("stop", { ...options, role });
  return { state: "stopped", graceful, ...(error ? { error } : {}) };
}

export async function createBackgroundControl(role, {
  baseDir = weftHome(), status, stop, activate,
  getStartTime = getProcessStartTime,
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
      status: () => status(),
      ...(activate ? { activate } : {}),
      quiesce: () => {
        // Let the authenticated reply complete before stopping the control endpoint itself.
        setTimeout(() => { void Promise.resolve().then(stop).catch(onStopError); }, 50);
        return { state: "stopping" };
      },
    },
  }, { connectionTimeoutMs: 60_000, keepAlive: true });
  if (!writeRegistryAtomic(registryName(role), {
    role, identity, capability, endpoint, pid: process.pid, processStartedAt,
  }, { baseDir })) {
    await host.close();
    throw new Error("Could not publish background control; startup was cancelled.");
  }
  return {
    async close() {
      if (readRegistry(registryName(role), { baseDir })?.identity?.runtimeInstanceId === identity.runtimeInstanceId) {
        clearRegistry(registryName(role), { baseDir });
      }
      await host.close();
    },
  };
}
