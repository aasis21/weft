// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { cpus, freemem, totalmem, uptime } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CPU_SAMPLE_MS = 500;
const APPS_CACHE_MS = 30_000;
const SLOW_CACHE_MS = 60_000;
const POWERSHELL_TIMEOUT_MS = 5_000;

const APPS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
@(
  Get-Process |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Group-Object ProcessName |
    ForEach-Object {
      [pscustomobject]@{
        id = $_.Name.ToLowerInvariant()
        name = $_.Name
        processCount = $_.Count
        windowCount = $_.Count
        memoryBytes = [int64](($_.Group | Measure-Object WorkingSet64 -Sum).Sum)
      }
    }
) | ConvertTo-Json -Depth 3 -Compress
`;

const BATTERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$result = @{ percent = $null; charging = $null; onAcPower = $null; batteryUnavailable = $false; powerUnavailable = $false }
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WeftPower {
  [StructLayout(LayoutKind.Sequential)]
  public struct Status {
    public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
    public uint BatteryLifeTime, BatteryFullLifeTime;
  }
  [DllImport("kernel32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetSystemPowerStatus(out Status status);
}
'@
  $power = New-Object WeftPower+Status
  if ([WeftPower]::GetSystemPowerStatus([ref]$power)) {
    if ($power.ACLineStatus -eq 0) { $result.onAcPower = $false }
    if ($power.ACLineStatus -eq 1) { $result.onAcPower = $true }
    if ($power.BatteryLifePercent -le 100) { $result.percent = [double]$power.BatteryLifePercent }
    if ($power.BatteryFlag -notin @(128, 255)) { $result.charging = ($power.BatteryFlag -band 8) -ne 0 }
  } else { $result.powerUnavailable = $true }
} catch { $result.powerUnavailable = $true }
try {
  $battery = Get-CimInstance Win32_Battery -ErrorAction Stop | Select-Object -First 1
  if ($null -ne $battery) {
    if ($null -ne $battery.EstimatedChargeRemaining) { $result.percent = [double]$battery.EstimatedChargeRemaining }
    if ($null -ne $battery.BatteryStatus) { $result.charging = $battery.BatteryStatus -in @(6, 7, 8, 9) }
  }
} catch {
  if ($null -eq $result.percent -and $null -eq $result.charging) { $result.batteryUnavailable = $true }
}
$result | ConvertTo-Json -Compress
`;

const APP_NAMES = Object.freeze({
  chrome: "Google Chrome",
  code: "Visual Studio Code",
  explorer: "File Explorer",
  msedge: "Microsoft Edge",
  "ms-teams": "Microsoft Teams",
  teams: "Microsoft Teams",
  windowsterminal: "Terminal",
});

const EXCLUDED_APPS = new Set(["taskmgr"]);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cpuTimes(osApi) {
  return osApi.cpus().reduce(
    (sum, core) => {
      const times = Object.values(core.times ?? {});
      return {
        idle: sum.idle + Number(core.times?.idle ?? 0),
        total: sum.total + times.reduce((total, value) => total + Number(value), 0),
      };
    },
    { idle: 0, total: 0 },
  );
}

async function sampleCpuPercent(osApi, wait, sampleMs) {
  const before = cpuTimes(osApi);
  await wait(sampleMs);
  const after = cpuTimes(osApi);
  const elapsed = after.total - before.total;
  if (elapsed <= 0) return null;
  const busy = elapsed - (after.idle - before.idle);
  return Math.round(Math.max(0, Math.min(100, (busy / elapsed) * 100)) * 10) / 10;
}

function friendlyAppName(id, rawName) {
  if (APP_NAMES[id]) return APP_NAMES[id];
  return String(rawName ?? id)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function normalizeApps(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return rows
    .filter((row) => row && typeof row.name === "string")
    .map((row) => {
      const id = typeof row.id === "string" && row.id ? row.id.toLowerCase() : row.name.toLowerCase();
      return {
        id,
        name: friendlyAppName(id, row.name),
        processCount: Number.isFinite(Number(row.processCount)) ? Math.max(1, Number(row.processCount)) : 1,
        windowCount: Number.isFinite(Number(row.windowCount)) ? Math.max(1, Number(row.windowCount)) : 1,
        memoryBytes: Number.isFinite(Number(row.memoryBytes)) ? Math.max(0, Number(row.memoryBytes)) : null,
      };
    })
    .filter((app) => app.id && app.name && !EXCLUDED_APPS.has(app.id))
    .sort((left, right) => (right.memoryBytes ?? 0) - (left.memoryBytes ?? 0) || left.name.localeCompare(right.name));
}

async function runPowerShell(execFn, script, timeoutMs) {
  const { stdout } = await execFn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(String(stdout ?? "").replace(/^\uFEFF/, "").trim() || "null");
}

function issue(component, error) {
  return {
    component,
    code: error?.killed || error?.code === "ETIMEDOUT" ? "timeout" : "unavailable",
  };
}

function isFresh(cache, now, maxAgeMs) {
  return cache.observedAt !== null && now - cache.observedAt < maxAgeMs;
}

function isAttemptDue(cache, now, maxAgeMs) {
  return cache.attemptedAt === null || now - cache.attemptedAt >= maxAgeMs;
}

export function createDeviceTelemetryCollector({
  platform = process.platform,
  now = Date.now,
  osApi = { cpus, freemem, totalmem, uptime },
  statfsFn = statfs,
  execFn = execFileAsync,
  wait = delay,
  cpuSampleMs = CPU_SAMPLE_MS,
  appsCacheMs = APPS_CACHE_MS,
  slowCacheMs = SLOW_CACHE_MS,
  powershellTimeoutMs = POWERSHELL_TIMEOUT_MS,
  diskPath = process.env.SystemDrive ? `${process.env.SystemDrive}\\` : process.cwd(),
} = {}) {
  const diskCache = {
    value: { usedBytes: null, totalBytes: null },
    observedAt: null,
    attemptedAt: null,
    issueCode: null,
  };
  const batteryCache = {
    value: { percent: null, charging: null, onAcPower: null },
    observedAt: null,
    attemptedAt: null,
    issueCode: null,
  };
  const appsCache = { value: [], observedAt: null, attemptedAt: null, issueCode: null };

  async function refreshDisk(capturedAt) {
    if (isFresh(diskCache, capturedAt, slowCacheMs) || !isAttemptDue(diskCache, capturedAt, slowCacheMs)) return;
    diskCache.attemptedAt = capturedAt;
    try {
      const stats = await statfsFn(diskPath);
      const blockSize = Number(stats.bsize);
      const totalBytes = blockSize * Number(stats.blocks);
      const availableBytes = blockSize * Number(stats.bavail);
      diskCache.value = {
        usedBytes: Number.isFinite(totalBytes - availableBytes) ? Math.max(0, totalBytes - availableBytes) : null,
        totalBytes: Number.isFinite(totalBytes) ? Math.max(0, totalBytes) : null,
      };
      diskCache.observedAt = capturedAt;
      diskCache.issueCode = null;
    } catch (error) {
      diskCache.issueCode = issue("disk", error).code;
    }
  }

  async function refreshApps(capturedAt) {
    if (platform !== "win32") {
      appsCache.issueCode = "unavailable";
      return;
    }
    if (isFresh(appsCache, capturedAt, appsCacheMs) || !isAttemptDue(appsCache, capturedAt, appsCacheMs)) return;
    appsCache.attemptedAt = capturedAt;
    try {
      appsCache.value = normalizeApps(await runPowerShell(execFn, APPS_SCRIPT, powershellTimeoutMs));
      appsCache.observedAt = capturedAt;
      appsCache.issueCode = null;
    } catch (error) {
      appsCache.issueCode = issue("apps", error).code;
    }
  }

  async function refreshBattery(capturedAt) {
    if (platform !== "win32") {
      batteryCache.observedAt ??= capturedAt;
      return;
    }
    if (
      isFresh(batteryCache, capturedAt, slowCacheMs) ||
      !isAttemptDue(batteryCache, capturedAt, slowCacheMs)
    ) {
      return;
    }
    batteryCache.attemptedAt = capturedAt;
    try {
      const battery = await runPowerShell(execFn, BATTERY_SCRIPT, powershellTimeoutMs);
      batteryCache.value = {
        percent: battery?.batteryUnavailable === true
          ? batteryCache.value.percent
          : Number.isFinite(battery?.percent) ? Math.max(0, Math.min(100, battery.percent)) : null,
        charging: battery?.batteryUnavailable === true
          ? batteryCache.value.charging
          : typeof battery?.charging === "boolean" ? battery.charging : null,
        onAcPower: battery?.powerUnavailable === true
          ? batteryCache.value.onAcPower
          : typeof battery?.onAcPower === "boolean" ? battery.onAcPower : null,
      };
      const partialFailure = battery?.batteryUnavailable === true || battery?.powerUnavailable === true;
      if (!partialFailure) batteryCache.observedAt = capturedAt;
      batteryCache.issueCode = partialFailure ? "unavailable" : null;
    } catch (error) {
      batteryCache.issueCode = issue("battery", error).code;
    }
  }

  return {
    async collectDeviceSnapshot() {
      const capturedAt = now();
      const issues = [];
      let cpuPercent = null;
      let memoryUsedBytes = null;
      let memoryTotalBytes = null;
      let uptimeSeconds = null;

      const [cpuResult] = await Promise.allSettled([
        sampleCpuPercent(osApi, wait, cpuSampleMs),
        refreshDisk(capturedAt),
        refreshApps(capturedAt),
        refreshBattery(capturedAt),
      ]);
      if (cpuResult.status === "fulfilled") {
        cpuPercent = cpuResult.value;
      } else {
        issues.push(issue("system", cpuResult.reason));
      }

      try {
        memoryTotalBytes = Number(osApi.totalmem());
        memoryUsedBytes = Math.max(0, memoryTotalBytes - Number(osApi.freemem()));
        uptimeSeconds = Math.max(0, Number(osApi.uptime()));
      } catch (error) {
        issues.push(issue("system", error));
      }
      if (diskCache.issueCode) issues.push({ component: "disk", code: diskCache.issueCode });
      if (batteryCache.issueCode) issues.push({ component: "battery", code: batteryCache.issueCode });
      if (appsCache.issueCode) issues.push({ component: "apps", code: appsCache.issueCode });

      return {
        capturedAt,
        system: {
          cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : null,
          memoryUsedBytes: Number.isFinite(memoryUsedBytes) ? memoryUsedBytes : null,
          memoryTotalBytes: Number.isFinite(memoryTotalBytes) ? memoryTotalBytes : null,
          uptimeSeconds: Number.isFinite(uptimeSeconds) ? uptimeSeconds : null,
          diskUsedBytes: diskCache.value.usedBytes,
          diskTotalBytes: diskCache.value.totalBytes,
          batteryPercent: batteryCache.value.percent,
          batteryCharging: batteryCache.value.charging,
          onAcPower: batteryCache.value.onAcPower,
        },
        apps: appsCache.value,
        observedAt: {
          system:
            cpuPercent !== null || memoryUsedBytes !== null || memoryTotalBytes !== null || uptimeSeconds !== null
              ? capturedAt
              : null,
          disk: diskCache.observedAt,
          battery: batteryCache.observedAt,
          apps: appsCache.observedAt,
        },
        issues,
      };
    },
  };
}

export const _test = { friendlyAppName, normalizeApps, sampleCpuPercent };
