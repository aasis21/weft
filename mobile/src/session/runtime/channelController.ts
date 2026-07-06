import type { WeftClient } from '@/lib/weftClient';

/** The named, per-channel timers the liveness/persistence FSM arms. Each is a fail-safe or a
 *  coalescing window; all are cleared together by {@link ChannelController.dispose}. */
export type TimerName =
  | 'confirm' // host-confirmation deadline (HOST_CONFIRM_MS)
  | 'settle' // bounded post-Live skeleton grace (INITIAL_HISTORY_GRACE_MS)
  | 'history' // recent-turns/history reply fail-safe (HISTORY_REQUEST_TIMEOUT_MS)
  | 'save' // coalesced transcript persist (PERSIST_THROTTLE_MS)
  | 'meta' // coalesced presence persist (META_PERSIST_THROTTLE_MS)
  | 'eventSave' // coalesced debug-log persist (PERSIST_THROTTLE_MS)
  | 'deviceEventSave'; // coalesced device (listener) debug-log persist (PERSIST_THROTTLE_MS)

type Handle = ReturnType<typeof setTimeout>;

/**
 * The imperative I/O handle for ONE joined channel: its live transport client, the event/status
 * unsubscribe, and the named timers the runtime's FSM arms. This is the EDGE's bookkeeping — none
 * of it lives in the store (a socket and a timer are not serializable state). The runtime owns one
 * of these per session id and tears the whole thing down with a single {@link dispose}.
 */
export class ChannelController {
  readonly id: string;
  readonly ephemeral: boolean;
  client: WeftClient | null = null;
  stopDemo?: () => Promise<void>;
  unsubscribe?: () => void;
  /** True while a reconnect is in flight, so overlapping triggers (resume + button) don't race. */
  reconnecting = false;
  /** When the current 'connecting' attempt began (ms), so a hung connect can be failed by the
   *  watchdog even before the confirm deadline is armed. */
  connectingSince: number | null = null;

  private timers = new Map<TimerName, Handle>();

  constructor(id: string, opts: { ephemeral?: boolean } = {}) {
    this.id = id;
    this.ephemeral = opts.ephemeral ?? false;
  }

  /** Arm (or re-arm) a named timer. Replaces any existing timer of the same name. */
  arm(name: TimerName, fn: () => void, ms: number): void {
    this.clear(name);
    this.timers.set(name, setTimeout(fn, ms));
  }

  /** Cancel a named timer if armed. */
  clear(name: TimerName): void {
    const handle = this.timers.get(name);
    if (handle != null) {
      clearTimeout(handle);
      this.timers.delete(name);
    }
  }

  /** True if the named timer is currently armed. */
  has(name: TimerName): boolean {
    return this.timers.has(name);
  }

  /** Detach the transport listeners without closing the socket (used before rebinding a client). */
  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Tear everything down: clear all timers, unsubscribe, and close the client/demo. Idempotent. */
  dispose(): void {
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    this.detach();
    void this.stopDemo?.().catch(() => {});
    void this.client?.close().catch(() => {});
    this.client = null;
  }
}
