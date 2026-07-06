# Runtime mode switching spike

## Question & summary verdict

**Verdict: Supported via `session.rpc.mode.set({ mode })` in the installed SDK.**

Weft is a Copilot CLI extension that joins the live foreground session with
`joinSession()`. The public `CopilotSession` class does not currently expose a
convenience `setMode()` method, but the joined session has typed session-scoped
RPC methods, including `session.rpc.mode.get()` and `session.rpc.mode.set(...)`.
Use that RPC as the primary implementation, and keep the existing slash-command
relay only as a compatibility fallback for older CLI/SDK hosts.

## Evidence

Installed SDK: `C:\Users\akash\Anya\bridge\node_modules\@github\copilot-sdk`
version `0.2.2` (`package.json`).

### `joinSession()` resumes the active CLI session

`C:\Users\akash\Anya\bridge\node_modules\@github\copilot-sdk\dist\extension.d.ts`

```ts
export type JoinSessionConfig = Omit<ResumeSessionConfig, "onPermissionRequest"> & {
    onPermissionRequest?: PermissionHandler;
};
/**
 * Joins the current foreground session.
 */
export declare function joinSession(config?: JoinSessionConfig): Promise<CopilotSession>;
```

`C:\Users\akash\Anya\bridge\node_modules\@github\copilot-sdk\dist\extension.js`

```js
async function joinSession(config = {}) {
  const sessionId = process.env.SESSION_ID;
  if (!sessionId) {
    throw new Error(
      "joinSession() is intended for extensions running as child processes of the Copilot CLI."
    );
  }
  const client = new CopilotClient({ isChildProcess: true });
  return client.resumeSession(sessionId, {
    ...config,
    onPermissionRequest: config.onPermissionRequest ?? defaultJoinSessionPermissionHandler,
    disableResume: config.disableResume ?? true
  });
}
```

### Session mode RPC exists and accepts exactly Weft's mode union

`C:\Users\akash\Anya\bridge\node_modules\@github\copilot-sdk\dist\generated\rpc.d.ts`

```ts
export interface SessionModeGetResult {
    /**
     * The current agent mode.
     */
    mode: "interactive" | "plan" | "autopilot";
}
export interface SessionModeSetResult {
    /**
     * The agent mode after switching.
     */
    mode: "interactive" | "plan" | "autopilot";
}
export interface SessionModeSetParams {
    /**
     * Target session identifier
     */
    sessionId: string;
    /**
     * The mode to switch to. Valid values: "interactive", "plan", "autopilot".
     */
    mode: "interactive" | "plan" | "autopilot";
}
```

`C:\Users\akash\Anya\bridge\node_modules\@github\copilot-sdk\dist\generated\rpc.d.ts`

```ts
/** Create typed session-scoped RPC methods. */
export declare function createSessionRpc(connection: MessageConnection, sessionId: string): {
    model: {
        getCurrent: () => Promise<SessionModelGetCurrentResult>;
        switchTo: (params: Omit<SessionModelSwitchToParams, "sessionId">) => Promise<SessionModelSwitchToResult>;
    };
    mode: {
        get: () => Promise<SessionModeGetResult>;
        set: (params: Omit<SessionModeSetParams, "sessionId">) => Promise<SessionModeSetResult>;
    };
```

`C:\Users\akash\Anya\bridge\node_modules\@github\copilot-sdk\dist\generated\rpc.js`

```js
mode: {
  get: async () => connection.sendRequest("session.mode.get", { sessionId }),
  set: async (params) => connection.sendRequest("session.mode.set", { sessionId, ...params })
},
```

### Mode changes are represented in session events

`C:\Users\akash\Anya\bridge\node_modules\@github\copilot-sdk\dist\generated\session-events.d.ts`

```ts
type: "session.mode_changed";
/**
 * Agent mode change details including previous and new modes
 */
data: {
    /**
     * Agent mode before the change (e.g., "interactive", "plan", "autopilot")
     */
    previousMode: string;
    /**
     * Agent mode after the change (e.g., "interactive", "plan", "autopilot")
     */
    newMode: string;
};
```

### No high-level `setMode()` wrapper, unlike model switching

`C:\Users\akash\Anya\bridge\node_modules\@github\copilot-sdk\dist\session.d.ts`
exposes `send`, `abort`, `setModel`, and `log`, but no `setMode`/`applyMode`.
The model wrapper delegates to RPC:

```ts
/**
 * Change the model for this session.
 */
setModel(model: string, options?: {
    reasoningEffort?: ReasoningEffort;
    modelCapabilities?: ModelCapabilitiesOverride;
}): Promise<void>;
```

`C:\Users\akash\Anya\bridge\node_modules\@github\copilot-sdk\dist\session.js`

```js
async setModel(model, options) {
  await this.rpc.model.switchTo({ modelId: model, ...options });
}
```

So for mode switching, use the analogous lower-level `session.rpc.mode.set(...)`
directly.

### `MessageOptions.mode` is not session mode

`C:\Users\akash\Anya\bridge\node_modules\@github\copilot-sdk\dist\types.d.ts`

```ts
/**
 * Options for sending a message to a session
 */
export interface MessageOptions {
    /**
     * The prompt/message to send
     */
    prompt: string;
    ...
    /**
     * Message delivery mode
     * - "enqueue": Add to queue (default)
     * - "immediate": Send immediately
     */
    mode?: "enqueue" | "immediate";
}
```

This `mode` controls **delivery/queueing** for `session.send(...)`; it is not
the agent/session mode. Anya uses it this way:

`C:\Users\akash\Anya\bridge\src\copilot-bridge.ts`

```ts
await chat.session.send({ prompt: text, attachments: sdkAttachments, mode: mode ?? 'enqueue' });
```

Weft should still use `{ mode: "immediate" }` for phone prompts if desired, but
that does not switch interactive/plan/autopilot.

### Sister/embedding examples

- `C:\Users\akash\vox\extension.mjs` joins the active session and registers
  slash commands/canvas, but does not set or change session mode.
- `C:\Users\akash\Anya\bridge\src\copilot-bridge.ts` configures sessions with
  `customAgents` and initial `agent: 'anya'`; no runtime session-mode switch is
  used there.
- `SessionConfig.agent` is only custom-agent selection:

```ts
/**
 * Name of the custom agent to activate when the session starts.
 * Must match the `name` of one of the agents in `customAgents`.
 * Equivalent to calling `session.rpc.agent.select({ name })` after creation.
 */
agent?: string;
```

Do not confuse custom-agent selection with interactive/plan/autopilot mode.

## Recommended Weft implementation

Weft already receives a CONTROL `mode` message carrying one of
`["interactive", "plan", "autopilot"]`. The handler should validate the mode,
call `session.rpc.mode.set({ mode })`, optionally verify with `get()`, and log
the result.

Code sketch for `extension/src/relay.mjs`:

```js
async function applyModeBestEffort(session, mode, logger) {
  if (!MODES.includes(mode)) {
    logger(`Weft: ignored unsupported mode "${mode}".`, { level: "warning" });
    return;
  }

  try {
    if (typeof session.rpc?.mode?.set === "function") {
      const result = await session.rpc.mode.set({ mode });
      logger(`Weft: mode switched -> ${result?.mode ?? mode}.`, {
        level: "info",
        ephemeral: false,
      });
      return;
    }
  } catch (err) {
    logger(`Weft: session.mode.set failed: ${err?.message ?? err}`, {
      level: "warning",
      ephemeral: false,
    });
  }

  // Compatibility fallback only; not the preferred path.
  if (typeof session.send === "function") {
    await session.send({ prompt: `/${mode}`, mode: "immediate" });
    logger(`Weft: relayed /${mode} as fallback; switch is not guaranteed.`, {
      level: "warning",
      ephemeral: false,
    });
  }
}
```

If the phone UI wants confirmation, listen for `session.mode_changed` and relay
the new mode back to the phone, or call `await session.rpc.mode.get()` after
setting.

## Fallbacks & limitations

- Primary path requires a CLI host that implements the generated
  `session.mode.set` JSON-RPC method. The installed SDK types and JS client know
  about it, but an older `copilot` host may reject the request.
- There is no documented `session.setMode()` convenience method in
  `CopilotSession`; do not wait for one.
- `session.send({ prompt: "/plan" | "/autopilot" | "/interactive" })` is only a
  best-effort fallback. It depends on real TUI slash-command behavior and may
  send a normal prompt if the command is unsupported.
- Switching to `plan` can trigger plan-approval flows. In the currently
  installed CLI SDK (`1.0.69-0`), plan exit is **not** delivered through the
  `onPermissionRequest` hook. It is a separate
  `exit_plan_mode.requested` / `exit_plan_mode.completed` session event flow.
  The response path is exposed as `session.rpc.ui.handlePendingExitPlanMode(...)`
  (with lower-level `respondToExitPlanMode(...)` types also present), so Weft
  relays that event to the phone as an approval banner and forwards the selected
  action back through the UI RPC.
- If `session.rpc.mode.set` is unavailable or fails consistently, the honest
  fallback is to tell the phone that runtime switching is unsupported by this
  host and require the user to switch mode in the terminal or restart in the
  desired mode.

## Open questions to verify against a real CLI

1. Does the currently installed `copilot` runtime accept all three
   `session.mode.set` values from a child extension process?
2. While a turn is actively running, does `mode.set` apply immediately, apply to
   the next turn, or fail until idle?
3. Answered for SDK `1.0.69-0`: listen for `exit_plan_mode.requested`, render
   its actions plus the "Suggest changes" decline path, and answer with
   `session.rpc.ui.handlePendingExitPlanMode({ requestId, response })`.
   NEEDS-REAL-CLI-VERIFICATION: confirm the terminal's exact action set/labels
   and the runtime's behavior for "Suggest changes" from a paired phone.
4. Are `/plan`, `/autopilot`, and `/interactive` real user-facing slash commands
   in the target CLI build? Treat them as fallback only until tested.
