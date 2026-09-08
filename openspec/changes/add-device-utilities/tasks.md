## 1. Shared Protocol

- [x] 1.1 Add clipboard and Keep Awake capability constants, message subtypes, factories, and TypeScript declarations
- [x] 1.2 Extend device snapshots with normalized AC-power state while preserving uptime compatibility
- [x] 1.3 Add shared protocol tests for request correlation, bounds, durations, and additive compatibility

## 2. Device Station

- [x] 2.1 Implement an injectable, bounded, text-only Windows clipboard adapter with sanitized errors
- [x] 2.2 Implement an injectable Windows Keep Awake controller with one bounded lease and shutdown cleanup
- [x] 2.3 Add power-state collection to device telemetry and its slow cache
- [x] 2.4 Advertise utility capabilities and handle clipboard and Keep Awake control messages in Device Station
- [x] 2.5 Add clipboard, Keep Awake, power telemetry, privacy, expiry, and listener lifecycle tests

## 3. Mobile Runtime

- [x] 3.1 Add runtime-only clipboard and Keep Awake state plus correlated reducers
- [x] 3.2 Add capability-gated runtime commands and redacted result handling
- [x] 3.3 Add scenario tests for clipboard reads/writes, stale results, Keep Awake start/extend/stop, and cleanup

## 4. Device Details UI

- [x] 4.1 Replace Uptime with an adaptive Power card and surface active Keep Awake time
- [x] 4.2 Replace disabled actions with Clipboard and Keep Awake actions and unsupported states
- [x] 4.3 Add accessible Clipboard and Keep Awake bottom sheets with explicit operations and cleared sensitive state
- [x] 4.4 Add responsive and accessibility tests for sheets, power states, durations, and action state

## 5. Documentation and Validation

- [x] 5.1 Update protocol, security, privacy, and user-facing documentation
- [x] 5.2 Run focused shared, extension, runtime, and Device Details tests
- [x] 5.3 Run repository tests, type checks, build, lint, OpenSpec validation, and read-only review
- [x] 5.4 Prepare the patch release, commit, fast-forward main, push, deploy, and verify the hosted manifest
