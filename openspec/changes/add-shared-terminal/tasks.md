## 1. Shared contract and dependencies

- [x] 1.1 Add terminal capability, request/state/output/snapshot factories, declarations, and protocol tests.
- [x] 1.2 Add compatible native PTY and xterm dependencies through npm.

## 2. Station and visible laptop terminal

- [x] 2.1 Implement one serialized PTY owner with bounded screen state, sequencing, ownership, validation, and process cleanup.
- [x] 2.2 Implement authenticated local attach IPC and a visible laptop terminal client, including close propagation.
- [x] 2.3 Wire laptop opt-in, CLI help, capability advertisement, encrypted controls, and private-content-safe diagnostics.
- [x] 2.4 Cover lifecycle, duplicate/stale input, authorization, reconnect, malformed requests, and cleanup in focused tests.
- [x] 2.5 Resolve review regressions: drain final output before close, keep local typing independent of relay latency, and enforce UTF-8 output byte limits.

## 3. Phone experience

- [x] 3.1 Wire capability-gated Open terminal, device navigation, terminal runtime, output sequencing, snapshots, and disconnect behavior.
- [x] 3.2 Build the responsive terminal screen, command editor, special keys, ownership, return-to-latest, and confirmed close.
- [x] 3.3 Add component/runtime and browser coverage, including reconnect and no terminal contents in diagnostic persistence.

## 4. Distribution and delivery

- [x] 4.1 Package native terminal dependencies for bundled builds, installers, and updates without requiring end-user compilers.
- [x] 4.2 Document authorization, one-terminal behavior, supported systems, lifecycle, privacy, and troubleshooting.
- [x] 4.3 Exercise real Windows PTY/local attach behavior and the built distribution, not only mocked shell tests.
- [ ] 4.4 Run repository tests/build/lint/version checks, mobile types, browser journeys, and scoped change review.
- [ ] 4.5 Commit and push the integrated change to main without overwriting concurrent work.
