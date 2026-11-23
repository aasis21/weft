// SPDX-License-Identifier: Apache-2.0
import { isDiagnosticLoggingEnabled } from "./transportConfig.mjs";

// In-memory, metadata-only record of encrypted traffic between this process and the paired phone.
// Only the (eventType, eventSubtype) pair, direction, encrypted size, timing and a pass/fail result
// are kept. Message text, prompts, paths, terminal output, clipboard contents and keys never enter
// an entry, and nothing is written to disk.

const LABELS = {
  "control:heartbeat": "Heartbeat",
  "control:device_heartbeat": "Station heartbeat",
  "control:project_list_request": "Project list requested",
  "control:project_list": "Project list",
  "control:session_list_request": "Session list requested",
  "control:session_list": "Session list",
  "control:open_session": "Open session",
  "control:lifecycle_status_request": "Launch status requested",
  "control:lifecycle_status": "Launch status",
  "control:lifecycle_cancel": "Cancel launch",
  "control:takeover_confirm": "Confirm takeover",
  "control:session_offers": "Sessions waiting for phone",
  "control:session_claimed": "Session adopted",
  "control:forget_device": "Forget this device",
  "control:device_monitor_start": "Device monitor started",
  "control:device_monitor_stop": "Device monitor stopped",
  "control:device_snapshot": "Device health snapshot",
  "control:terminal_request": "Terminal control",
  "control:terminal_state": "Terminal state",
  "control:terminal_output": "Terminal output",
  "control:terminal_snapshot": "Terminal snapshot",
  "control:clipboard_read": "Clipboard read requested",
  "control:clipboard_write": "Clipboard write requested",
  "control:clipboard_result": "Clipboard result",
  "control:keep_awake_start": "Keep awake on",
  "control:keep_awake_stop": "Keep awake off",
  "control:keep_awake_status_request": "Keep awake status requested",
  "control:keep_awake_status": "Keep awake status",
  "control:watch_request": "Attention requested",
  "control:watch_state": "Attention state",
  "control:session_status": "Session status",
  "control:session_meta": "Session details",
  "control:catch_up_request": "Catch-up requested",
  "control:catch_up_page": "Missed events",
  "control:channel_up": "Session connected",
  "control:channel_down": "Session disconnected",
  "control:workspace_request": "Workspace view requested",
  "control:workspace_result": "Workspace view",
  "control:mode": "Mode change",
  "control:interrupt": "Stop request",
  "control:history_request": "History requested",
  "control:history": "History page",
  "control:recent_turns_request": "Recent turns requested",
  "control:recent_turns": "Recent turns",
  "control:state_request": "Session state requested",
  "control:state_snapshot": "Session state",
  "control:voice_mode": "Voice mode",
  "control:invoke_command": "Run command",
  "stream:assistant_message": "Assistant reply",
  "stream:assistant_delta": "Assistant reply (streaming)",
  "stream:intent": "Agent intent",
  "stream:tool_start": "Tool started",
  "stream:tool_complete": "Tool finished",
  "stream:log": "Session log",
  "stream:activity": "Activity",
  "stream:user_message": "Laptop prompt",
  "prompt:prompt": "Prompt",
  "approval:request": "Approval requested",
  "approval:complete": "Approval resolved",
  "decision:approval_decision": "Approval answer",
  "elicitation:request": "Question asked",
  "elicitation:complete": "Question resolved",
  "elicitation_response:response": "Question answer",
  "local:phone_connected": "Phone connected",
  "local:phone_disconnected": "Phone connection lost",
};

// Inbound request -> outbound reply, so a slow or missing reply is visible.
const REPLIES = {
  "control:project_list_request": "control:project_list",
  "control:session_list_request": "control:session_list",
  "control:open_session": "control:lifecycle_status",
  "control:lifecycle_status_request": "control:lifecycle_status",
  "control:keep_awake_status_request": "control:keep_awake_status",
  "control:clipboard_read": "control:clipboard_result",
  "control:clipboard_write": "control:clipboard_result",
  "control:watch_request": "control:watch_state",
  "control:catch_up_request": "control:catch_up_page",
  "control:workspace_request": "control:workspace_result",
  "control:history_request": "control:history",
  "control:recent_turns_request": "control:recent_turns",
  "control:state_request": "control:state_snapshot",
  "decision:approval_decision": "approval:complete",
};

// High-frequency events are folded into one row instead of flooding the view.
const GROUPED = new Set([
  "control:heartbeat", "control:device_heartbeat", "control:device_snapshot", "control:terminal_output",
  "stream:assistant_delta", "stream:intent", "stream:activity", "stream:log",
]);
const HEARTBEATS = new Set(["control:heartbeat", "control:device_heartbeat"]);
const GROUP_WINDOW_MS = 60_000;
const NO_REPLY_MS = 60_000;

function eventKey(message) {
  const type = typeof message?.eventType === "string" ? message.eventType : "";
  const subtype = typeof message?.eventSubtype === "string" ? message.eventSubtype : "";
  const key = `${type}:${subtype}`;
  return LABELS[key] ? key : "other";
}

function failed(message) {
  const body = message?.msg;
  return body?.ok === false || body?.outcome === "failed";
}

function encryptedBytes(payload) {
  if (!payload || typeof payload !== "object") return 0;
  let total = 0;
  for (const value of Object.values(payload)) if (typeof value === "string") total += value.length;
  return total;
}

export function createTrafficLog({
  capacity = 100, now = Date.now, baseDir,
  enabled = () => isDiagnosticLoggingEnabled({ baseDir }),
} = {}) {
  const entries = [];
  const waiting = new Map();
  let sequence = 0;
  let enabledCache = { at: -Infinity, value: true };
  const isEnabled = () => {
    if (now() - enabledCache.at > 5_000) {
      let value = false;
      try { value = enabled() !== false; } catch { value = false; }
      enabledCache = { at: now(), value };
    }
    return enabledCache.value;
  };
  function push(entry) {
    entries.push(entry);
    if (entries.length > capacity) {
      const [removed] = entries.splice(0, entries.length - capacity);
      for (const queue of waiting.values()) {
        const index = queue.indexOf(removed);
        if (index >= 0) queue.splice(index, 1);
      }
    }
  }
  function add(direction, key, { bytes = 0, result } = {}) {
    if (!isEnabled()) return;
    const at = now();
    const last = entries.at(-1);
    if (GROUPED.has(key) && last && last.key === key && last.direction === direction &&
        last.result === result && at - last.lastAt < GROUP_WINDOW_MS) {
      last.count += 1;
      last.bytes += bytes;
      last.lastAt = at;
      return;
    }
    const entry = { id: ++sequence, at, lastAt: at, direction, key, count: 1, bytes, result };
    push(entry);
    return entry;
  }
  return {
    /** SecureChannel observer: inspects only the event identifiers and pass/fail fields. */
    observe({ direction, message, payload, ok = true }) {
      try {
        if (direction !== "in" && direction !== "out") return;
        const key = eventKey(message);
        const bytes = encryptedBytes(payload);
        if (direction === "out") {
          const result = !ok ? "failed" : failed(message) ? "failed" : "sent";
          const queue = waiting.get(key);
          const request = ok ? queue?.shift() : null;
          if (request) {
            request.result = result === "failed" ? "failed" : "replied";
            request.replyMs = now() - request.at;
          }
          add(direction, key, { bytes, result });
          return;
        }
        const reply = REPLIES[key];
        const entry = add(direction, key, { bytes, result: reply ? "waiting" : "received" });
        if (entry && reply) {
          const queue = waiting.get(reply) ?? [];
          queue.push(entry);
          if (queue.length > 20) queue.shift();
          waiting.set(reply, queue);
        }
      } catch {
        // Diagnostics must never affect message delivery.
      }
    },
    note(key) {
      if (LABELS[`local:${key}`]) add("in", `local:${key}`, { result: key === "phone_disconnected" ? "failed" : "received" });
    },
    snapshot() {
      const current = now();
      return entries.map((entry) => ({
        id: entry.id, at: entry.at, lastAt: entry.lastAt, direction: entry.direction,
        event: LABELS[entry.key] ?? "Other message", count: entry.count, bytes: entry.bytes,
        heartbeat: HEARTBEATS.has(entry.key),
        result: entry.result === "waiting" && current - entry.at > NO_REPLY_MS ? "no-reply" : entry.result,
        ...(entry.replyMs !== undefined ? { replyMs: entry.replyMs } : {}),
      }));
    },
  };
}
