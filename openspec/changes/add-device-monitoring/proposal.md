## Why

The Device Details screen shows whether a Windows device is reachable, but not what the computer is currently doing. A lightweight, on-demand device monitor will make the page useful as a mobile-native view of the PC without continuously streaming telemetry or exposing raw background processes.

## What Changes

- Advertise Device Station monitoring support through protocol capabilities.
- Add encrypted, monitor-ID-scoped control messages for starting, renewing, and stopping temporary monitoring and for returning ordered device snapshots.
- Collect Windows system utilization and user-facing applications from the Device Station process.
- Send an immediate snapshot when monitoring starts, followed by periodic snapshots only while Device Details is visible.
- Refresh fast system metrics on every tick while caching slower application, disk, and battery observations.
- Automatically expire monitoring when stop messages are missed because the phone disconnects or backgrounds.
- Display a compact device-health header, readable resource cards, and a privacy-preserving Running Now section designed for a phone rather than copying Task Manager.
- Keep the existing two-minute device heartbeat focused exclusively on liveness.

## Capabilities

### New Capabilities

- `device-monitoring`: On-demand collection, encrypted delivery, lifecycle management, and mobile presentation of Windows device telemetry.

### Modified Capabilities

None.

## Impact

- Shared message protocol and TypeScript declarations.
- Device Station control handling and Windows telemetry collection.
- Mobile session runtime, device state model, and Device Details UI.
- Protocol, listener, runtime, and screen tests.
- No new relay trust: snapshots continue to use the existing end-to-end encrypted device channel.
