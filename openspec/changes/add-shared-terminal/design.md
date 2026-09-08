## Context

Device Station owns an encrypted paired device channel in `extension/src/listener.mjs`.
The phone already routes device control messages independently of Copilot sessions.
Hosted installs use bundled JavaScript rather than a source checkout, so native PTY
distribution is part of the feature, not a developer-only prerequisite.

## Goals / Non-Goals

**Goals:** one real shell per Station/device, a visible local attach window, a usable
phone terminal, explicit remote-shell authorization, reconnect without re-execution,
and safe manual close from either end.

**Non-Goals:** arbitrary existing terminal takeover, multiple shells, persistence
across Station/laptop restart, background job survival after explicit terminal close,
or automatic command-completion inference from shell prompt text.

## Decisions

- Station owns `node-pty` and the actual shell. Windows uses ConPTY and the built-in
  Windows PowerShell unless a supported installed PowerShell is selected. A visible
  local terminal runs a new `weft terminal attach` client, not a second shell.
- Add `weft start --allow-terminal`. Without this explicit laptop-side grant, remote
  terminal actions are rejected. Advertise `DEVICE_CAPABILITY.TERMINAL_V1` with value
  `device-terminal-v1` only when authorized and supported. Old clients ignore it.
- The attach client communicates through authenticated local IPC, scoped to this
  Station and terminal generation. Attach credentials must not appear in command
  arguments, public artifacts, terminal output, or diagnostic logs. No public port.
- Opening is serialized and idempotent. `open` creates or reuses; `attach` never
  creates. Phone `detach` only unsubscribes; confirmed `close` ends the process tree.
  Natural shell exit and closing the owned local window close the terminal. Closing
  the phone UI or losing its connection does not close the terminal.
- Input has one owner (`phone` or `laptop`). The phone offers Take control; local
  interaction can claim control. Reject input from a non-owner rather than merging
  competing keystrokes. The controller chooses a shared terminal grid; the phone can
  pan a wider grid. Resize is bounded and never launches another shell.
- Use xterm.js on the phone and a headless terminal model plus serialization in
  Station for a reconnectable VT screen with bounded scrollback. Output chunks have
  sequence numbers. A snapshot establishes a sequence boundary; live chunks after
  it are applied once and gaps request a new snapshot, never command retransmission.
- Terminal input/output/snapshots are private session content and MUST bypass
  persistent diagnostic logs and generic raw-event capture. Lifecycle metadata
  without command/output bodies is sufficient.
- The mobile screen provides a multiline command editor with explicit Run, in-memory
  command recall, direct interactive terminal input, Tab/Escape/arrows/Ctrl+C, state,
  ownership, error/reconnect, and a confirmed Close action. It preserves reading
  position while output streams. Commands remain input to the existing shell.
- Native PTY support must be present in the installed distribution and verified
  independently of repository node_modules. Do not require end-user C++ compilers.

### Shared protocol contract

All four messages use `EVENT_TYPE.CONTROL`, with factories taking a single payload
object. These additions do not change existing messages.

| Constant / factory | Payload |
| --- | --- |
| `TERMINAL_REQUEST` / `terminalRequest` | `{requestId, action, terminalId?, projectName?, data?, inputSeq?, cols?, rows?}` |
| `TERMINAL_STATE` / `terminalState` | `{requestId, terminalId, status, shell, cwd, cols, rows, owner, nextInputSeq, error}` |
| `TERMINAL_OUTPUT` / `terminalOutput` | `{terminalId, seq, data}` |
| `TERMINAL_SNAPSHOT` / `terminalSnapshot` | `{terminalId, seq, data, cols, rows, truncated}` |

Subtype strings are respectively `terminal_request`, `terminal_state`,
`terminal_output`, `terminal_snapshot`. Request actions are `open`, `attach`,
`detach`, `input`, `resize`, `claim`, and `close`. State status is `opening`, `open`,
`closed`, or `error`; owner is `phone`, `laptop`, or null. State `requestId`,
`terminalId`, `shell`, `cwd`, and `error` are nullable; dimensions and `nextInputSeq`
are numeric. The input sequence is per phone and terminal generation. It starts at
1, accepts only the next value, ignores already-accepted values, and rejects gaps.
Only input actions consume it. Never automatically retry an unacknowledged input.

Validate action-specific fields and byte/dimension bounds at Station before acting.
Non-open requests require the matching live terminal ID. Shell/project selection
uses the registered project store, never a remotely supplied executable or path.
State replies include request correlation and actionable errors. Snapshot payloads
and buffers are bounded; omitted scrollback is explicitly marked `truncated`.

The complete JSON-escaped snapshot payload is limited to 128 KiB, leaving room for
authenticated envelope metadata and AES/base64 expansion within Supabase Free's
256 KB broadcast limit. Remove older serialized scrollback before reducing this
budget. If even the current screen cannot fit, return an explicit size error rather
than slicing arbitrary VT data. Ordinary output chunks remain at most 16 KiB.

## Risks / Trade-offs

- Native runtime packaging can work in a checkout but fail after install: test an
  isolated built distribution and a real Windows PTY lifecycle.
- A terminal exposes the local account's permissions: require opt-in and explain
  that the initial workspace is not a sandbox.
- Shared terminal geometry can distort full-screen programs: use explicit ownership,
  synchronize dimensions, and test resizing and ANSI rendering.
- Output floods can starve control traffic or consume memory: batch output, bound
  buffers and snapshots, and expose truncation instead of silently pretending completeness.
- Window close and transport loss have different meanings: only the owned local
  frontend or explicit close ends the shell; phone disconnection only detaches.

## Migration Plan

Ship additive protocol and capability negotiation. Existing installations remain
unchanged until updated and started with the explicit opt-in flag. Roll back by
restarting Station without that flag or restoring the preceding release. Preserve
pairing and configuration during update.

## Open Questions

Implementation validation must establish the native distribution layout and reliable
Windows visible-window launch/close behavior. These are delivery gates, not deferred
features.
