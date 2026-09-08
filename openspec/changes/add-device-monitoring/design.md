## Context

The Device Station is a long-running Node.js process on the paired computer. It already owns the encrypted device channel, sends a lightweight heartbeat every two minutes, and handles on-demand control requests such as project and resumable-session lists. The mobile runtime keeps per-device runtime state and the Device Details screen renders that state.

Device telemetry has different freshness and cost characteristics from liveness. CPU requires sampling, application discovery is Windows-specific, and continuously publishing telemetry would consume relay messages even when no user is looking at the page.

## Goals / Non-Goals

**Goals:**

- Show a fresh overview of CPU, memory, disk, battery, uptime, and visible Windows applications.
- Send telemetry only while the Device Details screen requests it.
- Deliver every snapshot through the existing end-to-end encrypted device channel.
- Recover cleanly from phone backgrounding, disconnects, and missed stop messages.
- Keep telemetry collection isolated and testable.

**Non-Goals:**

- Reproduce Task Manager or enumerate background services.
- Persist historical telemetry or provide charts.
- Remotely terminate, focus, or control applications.
- Include window titles, document names, or browser tab titles.
- Change the existing heartbeat cadence or meaning.

## Decisions

### Advertise support before monitoring

`PROJECT_LIST` gains an optional `capabilities` array. A station that implements this design advertises `device-monitor-v1`. Existing phones ignore the additive field, while a new phone can avoid showing an endless loading state against an older station and instead explain that the laptop-side Weft version must be updated.

This is preferable to inferring support from an application version because capability flags describe behavior directly and survive independent release-version changes.

### Use a monitor-ID-scoped lease

The phone creates a fresh random `monitorId` each time Device Details becomes visible and sends:

```text
DEVICE_MONITOR_START {
  monitorId,
  intervalMs: 10000,
  leaseMs: 45000
}
```

The station clamps the requested values, replaces any previous monitor, immediately sends a snapshot, and continues at the effective interval. While the page remains visible, the phone renews the same lease by resending `DEVICE_MONITOR_START` with the same `monitorId`. Leaving the page sends `DEVICE_MONITOR_STOP { monitorId }`.

A stop command only affects the matching monitor. This prevents a delayed stop from an older screen instance from terminating a newer monitor. Lease expiry guarantees cleanup when the stop is lost because the phone disconnects or is suspended.

This is preferable to permanent push because idle devices generate no telemetry, and preferable to repeated phone polling because collection cadence and cleanup remain centralized at the station.

### Keep heartbeat and telemetry separate

`DEVICE_HEARTBEAT` remains a lightweight liveness message every 120 seconds. Telemetry uses separate subtypes and does not affect the device's online semantics beyond the existing rule that any valid control message proves recent contact.

### Send one ordered snapshot shape with independently observed sections

Each `DEVICE_SNAPSHOT` identifies the monitor and contains a monotonically increasing sequence:

```text
{
  schemaVersion: 1,
  monitorId,
  sequence,
  capturedAt,
  leaseExpiresAt,
  effectiveIntervalMs,
  system: {
    cpuPercent,
    memoryUsedBytes,
    memoryTotalBytes,
    uptimeSeconds,
    diskUsedBytes,
    diskTotalBytes,
    batteryPercent,
    batteryCharging
  },
  apps: [{ id, name, processCount, windowCount, memoryBytes }],
  observedAt: {
    system,
    disk,
    battery,
    apps
  },
  issues: [{ component, code }]
}
```

The phone accepts only snapshots matching its active `monitorId` and ignores an equal or lower sequence. Stable issue codes communicate partial failure without transmitting raw local exception text or paths.

### Collect metrics at different internal cadences

The station publishes a complete snapshot at the requested cadence, but it does not recollect every field each time:

| Section | Default observation cadence |
|---|---:|
| CPU and memory | Every snapshot, normally 10 seconds |
| Visible applications | 30 seconds |
| Disk capacity | 60 seconds |
| Battery | 60 seconds |
| Uptime | Every snapshot |

Cached slower values remain in each full snapshot with section-specific `observedAt` timestamps. This keeps the mobile state and rendering simple while avoiding an expensive PowerShell/CIM query every ten seconds.

### Collect portable metrics in Node and Windows applications through PowerShell

Node's built-in `os` and `fs.statfs` APIs provide CPU sampling inputs, memory, uptime, and disk capacity without a dependency. On Windows, a bounded non-interactive PowerShell command enumerates processes with a visible main window and returns application name, process count, and aggregate working-set memory. Window titles are not transmitted. Battery is queried best-effort through Windows CIM.

The collector returns nullable fields when the operating system cannot provide a metric. Collection failures become stable component issue codes rather than raw exception messages and never terminate the Device Station.

### Make Device Details glanceable rather than Task Manager-shaped

The page uses this hierarchy:

```text
┌──────────────────────────────────────┐
│ Devbox                     ● Online  │
│ Windows · updated just now           │
├──────────────────────────────────────┤
│ CPU 18%   Memory 62%   Disk 71%     │
│ Uptime 2d 4h            Battery 81% │
├──────────────────────────────────────┤
│ QUICK ACTIONS                        │
│ Start Copilot       Resume Copilot  │
│ Explore Files       Open Terminal   │
├──────────────────────────────────────┤
│ RUNNING NOW · 5 APPS                 │
│ Visual Studio Code        3 windows  │
│ Microsoft Edge            1.2 GB     │
│ Terminal                  2 windows  │
├──────────────────────────────────────┤
│ COPILOT WORKSPACES · 3               │
│ 📁 ModernOrder                        │
│    …\CLP\SC.CST.ModernOrder          │
├──────────────────────────────────────┤
│ ACTIVE COPILOT SESSIONS               │
├──────────────────────────────────────┤
│ INACTIVE COPILOT SESSIONS             │
└──────────────────────────────────────┘
```

The system area shows percentage-first values with small progress indicators; secondary text carries absolute values such as `9.8 / 16 GB`. Uptime is a full metric rather than header metadata. Battery is hidden when unavailable. Quick actions use a uniform two-column card grid; Start and Resume are active, while actions whose protocol is not implemented remain visibly marked as coming soon. Running Now shows only visible user applications, uses friendly names, and limits the initial list to the five most relevant entries with a `Show all` affordance. Registered project folders are presented to users as Copilot workspaces, with readable names, compact path context, a default marker, and controlled expansion for longer lists. High CPU or memory may add a compact accent, but zero-value Task Manager columns are never rendered.

Application relevance is ordered by foreground status when available, then aggregate memory. Multiple processes/windows are grouped into one row. Window titles, file names, browser tabs, executable paths, and application-control buttons are excluded from the MVP.

### Treat snapshots as runtime-only state

Snapshots are stored only in the mobile Redux runtime. They are replaced atomically by newer snapshots and cleared when the device is removed. The UI displays capture time so stale data is distinguishable from current data.

## Risks / Trade-offs

- **PowerShell process discovery can be slow or restricted** → Use a timeout and a 30-second cache; keep other metrics working and mark only the applications section unavailable.
- **CPU percentages require two samples** → The collector samples over a short bounded interval before producing each snapshot rather than reporting cumulative CPU time.
- **Monitoring stop can be lost** → Every start has a short lease that expires unless renewed.
- **Application names may still reveal usage patterns** → Exclude window titles and background processes; telemetry remains end-to-end encrypted.
- **A delayed stop can race a newly opened page** → Scope every lifecycle message to a fresh monitor ID and ignore mismatches.
- **Frequent snapshots consume relay quota** → Clamp the interval to a conservative minimum, cache slow observations, and run only while the page is visible.
- **An older station silently ignores new messages** → Advertise `device-monitor-v1` in the existing project-list response and render an upgrade state when absent.

## Migration Plan

The protocol additions are backward-compatible. New phones request monitoring only when `PROJECT_LIST.capabilities` contains `device-monitor-v1`; older phones ignore that optional field. Snapshots are runtime-only and require no persisted-data migration. Rollback removes the new UI and message handling without changing paired-device records.

## Open Questions

- Application icons are deferred because extracting and transferring them adds platform-specific complexity and payload size.
- Foreground-app detection may be added if it can be collected reliably without transmitting window details.
- Remote application controls can be designed separately after the read-only experience proves useful.
