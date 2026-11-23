// Type definitions for the shared session-health projection (LLD §3.1, §4, §5.4; HLD §6.2/§6.3).

export type SessionHealthLabel =
  | "dormant"
  | "connecting"
  | "waiting"
  | "linked"
  | "stalled"
  | "ending"
  | "gone";

/** Why a session is not plainly healthy. `null` when nothing needs explaining. */
export type SessionHealthReason =
  | "phone-away"
  | "link-stuck"
  | "unresponsive"
  | "owner-unknown"
  | "controller-conflict"
  | "endpoint-changed"
  | "config-error"
  | "shared-outage"
  | "needs-attention"
  | "update-required";

/** "session" = derived from the record alone (no outside observation supplied). */
export type SessionHealthObserver = "station" | "phone" | "session";

export type ConfigErrorCode =
  | "auth-failed"
  | "forbidden"
  | "invalid-config"
  | "missing-config"
  | "unsupported-transport"
  | "identity-invalid";

export const LABELS: readonly SessionHealthLabel[];
export const REASONS: readonly SessionHealthReason[];
/** `link.lastError.code` values that retrying cannot fix (surface, never auto-repair). */
export const CONFIG_ERROR_CODES: readonly ConfigErrorCode[];
/** Live-record schema understood by this build; any other value projects to `update-required`. */
export const SESSION_RECORD_SCHEMA: 1;
/** Consecutive missed pipe probes before a live runtime is `unresponsive`. */
export const UNRESPONSIVE_PROBE_MISSES: 2;

/** Written link state. `stalled` is never written; it is derived. */
export type SessionLinkState = "dormant" | "connecting" | "waiting" | "linked" | "ending";

/** `~/.weft/sessions-live/<runtimeId>.json`, written only by that session (LLD §3.1). */
export interface SessionLiveRecord {
  schema: number;
  session: { storeAuthority: string; sessionId: string };
  run: {
    runtimeId: string;
    generation: number;
    pid: number;
    processStartedAt: number;
    terminalInstanceId?: string;
    version: string;
    openedBy?: { kind: "station" | "terminal"; requestId?: string };
  };
  control?: { pipe: string };
  link: {
    state: SessionLinkState;
    generation: number;
    attempt?: number;
    deadlineAt?: number | null;
    lastError?: { code: string; at: number } | null;
    controllerRevision?: number;
    lastPhoneContactAt?: number | null;
    /** The phone's attention lease; `false` = phone backgrounded (never a failure). */
    phoneWatching?: boolean;
    endpointRevision?: number;
  };
  offer?: { expiresAt: number } | null;
  updatedAt: number;
}

/** Outside facts. Station fills the laptop-side fields; the phone fills `phone`. */
export interface SessionObservation {
  observer: "station" | "phone";
  /** Latest pipe probe; `misses` counts consecutive failed probes. */
  probe?: { ok: boolean; at: number; misses: number };
  /** Process identity check (pid + start time). `null`/absent = not checked. */
  processAlive?: boolean | null;
  /** Two live runtimes claim the same `(storeAuthority, sessionId)`. */
  ownerConflict?: boolean;
  /** A live process may hold the session but ownership cannot be proven. */
  ownerUnknown?: boolean;
  /** Every linked/waiting session went link-stuck in the same sweep (shared transport issue). */
  sharedOutage?: boolean;
  /** Supervisor repair episode for this runtime (LLD §4.3). */
  episode?: { attempts: number; exhausted: boolean };
  phone?: {
    lastTrafficAt?: number;
    /** Last failed handshake; counts only when newer than `lastTrafficAt`. */
    handshakeFailedAt?: number;
    /** Controller revision the phone last held; older than the record's → `controller-conflict`. */
    controllerRevision?: number;
    /** Endpoint revision the phone last used; older than the record's → `endpoint-changed`. */
    endpointRevision?: number;
  };
}

export interface SessionHealth {
  label: SessionHealthLabel;
  reason: SessionHealthReason | null;
  observer: SessionHealthObserver;
  /** Newest timestamp among the facts used (record, probe, phone traffic/handshake); null if none. */
  freshAt: number | null;
}

/**
 * Pure projection. First matching rule wins:
 *  1. no record → `stalled/owner-unknown` if a process is alive or ownership is unknown/conflicting,
 *     else `gone`. (Pass `null` only when the observer looked and found no record.)
 *  2. `processAlive === false` → `gone`.
 *  3. unknown `schema` or `link.state` → `stalled/update-required`.
 *  4. `ownerConflict` or `ownerUnknown` → `stalled/owner-unknown`.
 *  5. `link.state === "ending"` → `ending`.
 *  6. `probe.misses >= 2` → `stalled/unresponsive`.
 *  7. `episode.exhausted` → `stalled/needs-attention`.
 *  8. connecting/dormant with a {@link CONFIG_ERROR_CODES} `lastError` → `stalled/config-error`.
 *  9. phone behind on `controllerRevision` → `stalled/controller-conflict`.
 * 10. phone behind on `endpointRevision` → `stalled/endpoint-changed`.
 * 11. connecting past `deadlineAt` → `stalled/link-stuck` (`shared-outage` when flagged); else `connecting`.
 * 12. waiting/linked with a handshake failure newer than phone traffic → `stalled/link-stuck`
 *     (`shared-outage` when flagged).
 * 13. linked → `linked`, reason `phone-away` when `phoneWatching === false` (never stalled).
 * 14. otherwise the written state (`waiting` / `dormant`), reason null.
 */
export function sessionHealth(
  record: SessionLiveRecord | null,
  observation?: SessionObservation | null,
  now?: number
): SessionHealth;
