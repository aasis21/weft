import type { LifecycleStatusMsg, OpenReason, SpawnMode } from '@aasis21/weft-shared';
import { loadPendingOperations } from '@/lib/pendingOperations';
import { saveCriticalPreference } from '@/lib/storageJanitor';
import {
  preferencesStorage,
  type PersistStorage,
} from '@/services/persistence/preferencesStorage';
import { openStatusMessage, requiresTakeoverConfirmation } from '@/session/openStatus';
import type { SessionRuntime } from '@/session/runtime/sessionRuntime';

export { openStatusMessage, requiresTakeoverConfirmation };

const SESSION_ACCESS_KEY = 'weft.sessionAccess.v1';

/**
 * What the user asked to open. `new` and `existing` become a protocol v3 `open_session` target
 * (`{ project }` / `{ sessionId }`) — Station decides activate, repair, resume or start. `offer`
 * pairs to a session a laptop is offering over its device channel.
 */
export type SessionAccessTarget =
  | { kind: 'new'; projectName: string }
  | { kind: 'existing'; sessionId: string; storeAuthority?: string | null }
  | { kind: 'offer'; offerChannelId: string };

export interface SessionOpenIntent {
  requestId?: string;
  deviceChannelId: string;
  target: SessionAccessTarget;
  mode?: SpawnMode;
  name?: string | null;
  /** First message for a new session, typed before it was ready; sent once the phone pairs. */
  initialPrompt?: string | null;
  title?: string | null;
  cwd?: string | null;
}

interface NormalizedSessionOpenIntent extends SessionOpenIntent {
  requestId: string;
  mode: SpawnMode;
  name: string | null;
  initialPrompt: string | null;
  title: string | null;
  cwd: string | null;
}

interface PersistedSessionOperation {
  intent: NormalizedSessionOpenIntent;
  /** Same request id must mean the same request (idempotency key, LLD §3.2). */
  key: string;
  status: LifecycleStatusMsg;
  /** Newest Station revision applied; local-only updates never advance it. */
  stationRevision?: number;
  createdAt: number;
  runtimeCardId?: string;
  sourceDeviceId?: string;
}

export interface SessionAccessRuntime {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ReturnType<SessionRuntime['getSnapshot']>;
  setActive(channelId: string): void;
  spawnSession(
    channelId: string,
    opts: { projectName: string; mode: SpawnMode; name?: string; initialPrompt?: string; requestId?: string },
  ): Promise<string>;
  resumeSession(
    channelId: string,
    opts: {
      sessionId: string;
      storeAuthority?: string | null;
      mode: SpawnMode;
      title?: string | null;
      cwd?: string | null;
      requestId?: string;
    },
  ): Promise<string>;
  joinOfferedSession(deviceChannelId: string, offerChannelId: string): Promise<string>;
  retrySpawn(channelId: string): Promise<string | null>;
  remove(channelId: string): Promise<void>;
  getLifecycleStatus(requestId: string): LifecycleStatusMsg | null;
  confirmLifecycleTakeover(
    channelId: string,
    requestId: string,
    challengeId: string,
    revision: number,
  ): Promise<LifecycleStatusMsg>;
  cancelLifecycleOperation(
    channelId: string,
    requestId: string,
    revision: number,
  ): Promise<LifecycleStatusMsg>;
}

export interface SessionAccess {
  init(): Promise<void>;
  open(intent: SessionOpenIntent): Promise<LifecycleStatusMsg>;
  confirmTakeover(requestId: string): Promise<LifecycleStatusMsg>;
  cancel(requestId: string): Promise<LifecycleStatusMsg>;
  inspect(requestId: string): Promise<LifecycleStatusMsg | null>;
}

interface SessionAccessOptions {
  storage?: PersistStorage;
  clock?: () => number;
  randomId?: () => string;
}

/** The request ended without opening the session. */
export function openFailed(status: LifecycleStatusMsg): boolean {
  return status.outcome === 'failed' || status.outcome === 'cancelled' || status.outcome === 'outcome-unknown';
}

/** Plain words for an unsuccessful open request (empty-safe fallback). */
export function lifecycleFailureMessage(status: LifecycleStatusMsg | null | undefined): string {
  return (status && openStatusMessage(status)) || 'The session could not be opened.';
}

function intentKey(intent: NormalizedSessionOpenIntent): string {
  return JSON.stringify([intent.deviceChannelId, intent.target, intent.mode, intent.name]);
}

function reasonFor(message: string): OpenReason {
  if (/no longer available|no longer exists|not found/i.test(message)) return 'not-found';
  if (/timed out|timeout|has not answered yet/i.test(message)) return 'timeout';
  if (/not connected|could not reach|offline|unreachable/i.test(message)) return 'runtime-unavailable';
  if (/could not connect|phone is not connected yet|pairing/i.test(message)) return 'link-failed';
  return 'internal-error';
}

function isStatus(value: unknown, requestId: string): value is LifecycleStatusMsg {
  const status = value as Partial<LifecycleStatusMsg> | null;
  return !!status && status.requestId === requestId && typeof status.stage === 'string' &&
    Number.isSafeInteger(status.revision);
}

export class RuntimeSessionAccess implements SessionAccess {
  private readonly operations = new Map<string, PersistedSessionOperation>();
  private readonly storage: PersistStorage;
  private readonly clock: () => number;
  private readonly randomId: () => string;
  private readonly unsubscribe: () => void;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly runtime: SessionAccessRuntime,
    options: SessionAccessOptions = {},
  ) {
    this.storage = options.storage ?? { ...preferencesStorage, setItem: saveCriticalPreference };
    this.clock = options.clock ?? Date.now;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.unsubscribe = runtime.subscribe(() => this.reconcileRuntime());
  }

  async init(): Promise<void> {
    await this.ensureLoaded();
    this.reconcileRuntime();
  }

  dispose(): void {
    this.unsubscribe();
  }

  async open(input: SessionOpenIntent): Promise<LifecycleStatusMsg> {
    await this.ensureLoaded();
    const target = input.target;
    const intent: NormalizedSessionOpenIntent = {
      ...input,
      requestId: input.requestId?.trim() || `open-${this.randomId()}`,
      mode: input.mode === 'allow-all' ? 'allow-all' : 'default',
      name: target.kind === 'new' ? input.name?.trim() || null : null,
      initialPrompt: target.kind === 'new' ? input.initialPrompt?.trim() || null : null,
      title: input.title?.trim() || null,
      cwd: input.cwd?.trim() || null,
    };
    const key = intentKey(intent);
    const previous = this.operations.get(intent.requestId);
    if (previous) {
      if (previous.key === key) return previous.status;
      return {
        ...previous.status,
        outcome: 'failed',
        reason: 'invalid-request',
        result: { message: 'This request ID was already used for a different request.' },
      };
    }
    const now = this.clock();
    const device = this.runtime.getSnapshot().devices.find((item) => item.channelId === intent.deviceChannelId);
    const record: PersistedSessionOperation = {
      intent,
      key,
      createdAt: now,
      sourceDeviceId: device?.deviceId ?? intent.deviceChannelId,
      status: { requestId: intent.requestId, revision: 0, stage: 'accepted', outcome: null, reason: null, result: null },
    };
    this.operations.set(intent.requestId, record);
    await this.persist();
    return this.execute(record);
  }

  async confirmTakeover(requestId: string): Promise<LifecycleStatusMsg> {
    await this.ensureLoaded();
    this.reconcileRuntime();
    const record = this.operations.get(requestId);
    if (!record) return this.missingOperation(requestId);
    if (!requiresTakeoverConfirmation(record.status)) {
      return { ...record.status, outcome: 'failed', reason: 'takeover-stale', result: record.status.result };
    }
    const status = await this.runtime.confirmLifecycleTakeover(
      record.intent.deviceChannelId,
      requestId,
      record.status.result.challenge.challengeId,
      record.status.revision,
    );
    this.applySnapshot(record, status);
    await this.persist();
    return record.status;
  }

  async cancel(requestId: string): Promise<LifecycleStatusMsg> {
    await this.ensureLoaded();
    this.reconcileRuntime();
    const record = this.operations.get(requestId);
    if (!record) return this.missingOperation(requestId);
    const stationStatus = this.runtime.getLifecycleStatus(requestId);
    const stationFinished = !!stationStatus && stationStatus.outcome !== null;
    if (record.status.outcome === 'done' || record.status.outcome === 'cancelled' || stationFinished) {
      if (record.status.outcome !== 'done' && record.runtimeCardId) await this.runtime.remove(record.runtimeCardId);
      return record.status;
    }
    const card = record.runtimeCardId
      ? this.runtime.getSnapshot().sessions.find((session) => session.meta.channelId === record.runtimeCardId)
      : undefined;
    // Station knows the request once it answered or the open was delivered and is still pending.
    const stationKnows = record.stationRevision !== undefined ||
      (!!card?.spawning && card.spawning.stage !== 'not-delivered' && card.status !== 'error');
    if (stationKnows) {
      try {
        const status = await this.runtime.cancelLifecycleOperation(
          record.intent.deviceChannelId,
          requestId,
          record.status.revision,
        );
        this.applySnapshot(record, status);
      } catch {
        this.setLocal(record, { outcome: 'cancelled', reason: null });
      }
    } else {
      // Never reached (or never answered from) Station: tell it best-effort, finish here.
      void this.runtime.cancelLifecycleOperation(record.intent.deviceChannelId, requestId, record.status.revision)
        .catch(() => {});
      this.setLocal(record, { outcome: 'cancelled', reason: null });
    }
    await this.persist();
    const finished: LifecycleStatusMsg = record.status;
    if (finished.outcome === 'cancelled' && record.runtimeCardId) {
      await this.runtime.remove(record.runtimeCardId);
    }
    return finished;
  }

  async inspect(requestId: string): Promise<LifecycleStatusMsg | null> {
    await this.ensureLoaded();
    this.reconcileRuntime();
    return this.operations.get(requestId)?.status ?? null;
  }

  async retry(requestId: string): Promise<LifecycleStatusMsg> {
    await this.ensureLoaded();
    const record = this.operations.get(requestId);
    if (!record) return this.missingOperation(requestId);
    this.setLocal(record, { outcome: null, reason: null, result: null });
    await this.persist();
    const card = record.runtimeCardId
      ? this.runtime.getSnapshot().sessions.find((session) => session.meta.channelId === record.runtimeCardId)
      : undefined;
    if (card?.spawning) {
      await this.runtime.retrySpawn(card.meta.channelId);
      this.reconcileRuntime();
      return record.status;
    }
    return this.execute(record);
  }

  private async execute(record: PersistedSessionOperation): Promise<LifecycleStatusMsg> {
    const { intent } = record;
    try {
      let cardId: string;
      if (intent.target.kind === 'new') {
        cardId = await this.runtime.spawnSession(intent.deviceChannelId, {
          projectName: intent.target.projectName,
          mode: intent.mode,
          ...(intent.name ? { name: intent.name } : {}),
          ...(intent.initialPrompt ? { initialPrompt: intent.initialPrompt } : {}),
          requestId: intent.requestId,
        });
      } else if (intent.target.kind === 'offer') {
        cardId = await this.runtime.joinOfferedSession(intent.deviceChannelId, intent.target.offerChannelId);
      } else {
        cardId = await this.runtime.resumeSession(intent.deviceChannelId, {
          sessionId: intent.target.sessionId,
          storeAuthority: intent.target.storeAuthority ?? null,
          mode: intent.mode,
          title: intent.title,
          cwd: intent.cwd,
          requestId: intent.requestId,
        });
      }
      record.runtimeCardId = cardId;
      const session = this.runtime.getSnapshot().sessions.find((item) => item.meta.channelId === cardId);
      if (session?.meta.kind === 'spawning') {
        this.reconcileRuntime();
      } else {
        // The phone already holds this session (reconnected) or paired to an offer: done locally.
        this.setLocal(record, {
          stage: 'preparing-link',
          outcome: 'done',
          reason: null,
          result: session?.meta.sessionId ? { sessionId: session.meta.sessionId } : null,
        });
        await this.persist();
      }
      return record.status;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The session could not be opened.';
      this.setLocal(record, { outcome: 'failed', reason: reasonFor(message), result: { message } });
      await this.persist();
      return record.status;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const raw = await this.storage.getItem(SESSION_ACCESS_KEY).catch(() => null);
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as { operations?: PersistedSessionOperation[] };
            for (const operation of parsed.operations ?? []) {
              const requestId = operation?.intent?.requestId;
              // Records from before protocol v3 (keyed by `operationId`) are dropped.
              if (typeof requestId === 'string' && requestId && isStatus(operation.status, requestId)) {
                this.operations.set(requestId, operation);
              }
            }
          } catch {
            // A corrupt record set is discarded; pending launches below still restore.
          }
        }
        const pending = await loadPendingOperations();
        for (const operation of pending) {
          if (this.operations.has(operation.requestId)) continue;
          const intent: NormalizedSessionOpenIntent = {
            requestId: operation.requestId,
            deviceChannelId: operation.deviceId,
            target: operation.kind === 'new'
              ? { kind: 'new', projectName: operation.projectName }
              : { kind: 'existing', storeAuthority: operation.storeAuthority ?? null, sessionId: operation.sessionId ?? '' },
            mode: operation.mode,
            name: operation.name ?? null,
            title: operation.title ?? null,
            cwd: operation.cwd ?? null,
            initialPrompt: operation.initialPrompt ?? null,
          };
          const station = isStatus(operation.lifecycleStatus, operation.requestId) ? operation.lifecycleStatus : null;
          this.operations.set(operation.requestId, {
            intent,
            key: intentKey(intent),
            createdAt: operation.createdAt,
            runtimeCardId: operation.tempId,
            sourceDeviceId: operation.spawnedFromDeviceId,
            ...(station ? { stationRevision: station.revision } : {}),
            status: station ?? {
              requestId: operation.requestId,
              revision: 0,
              stage: 'accepted',
              outcome: null,
              reason: null,
              result: null,
            },
          });
        }
        this.loaded = true;
      })();
    }
    await this.loadPromise;
  }

  private reconcileRuntime(): void {
    if (!this.loaded) return;
    const snapshot = this.runtime.getSnapshot();
    let changed = false;
    for (const record of this.operations.values()) {
      const requestId = record.intent.requestId;
      const station = this.runtime.getLifecycleStatus(requestId);
      if (station) changed = this.applySnapshot(record, station) || changed;
      if (record.status.outcome !== null && record.status.outcome !== 'failed') continue;
      if (requiresTakeoverConfirmation(record.status)) continue;
      const spawning = snapshot.sessions.find((session) => session.spawning?.requestId === requestId);
      if (spawning) {
        record.runtimeCardId = spawning.meta.channelId;
        if (spawning.error && record.status.outcome === null && !(station && station.outcome !== null)) {
          // A phone-side failure (not delivered, no answer, pairing failed); retry keeps the request id.
          const reason: OpenReason = spawning.spawning?.stage === 'pairing-failed' ? 'link-failed' : reasonFor(spawning.error);
          changed = this.setLocal(record, { outcome: 'failed', reason, result: { message: spawning.error } }) || changed;
        } else if (!spawning.error && record.status.outcome === 'failed' && !(station && station.outcome !== null)) {
          // Retried from the card itself.
          changed = this.setLocal(record, { outcome: null, reason: null, result: null }) || changed;
        }
        continue;
      }
      if (record.status.outcome !== null || !record.runtimeCardId) continue;
      const opened = this.findOpenedSession(record, snapshot.sessions);
      if (opened) {
        record.runtimeCardId = opened.meta.channelId;
        changed = this.setLocal(record, {
          stage: 'preparing-link',
          outcome: 'done',
          reason: null,
          result: { ...(record.status.result ?? {}), ...(opened.meta.sessionId ? { sessionId: opened.meta.sessionId } : {}) },
        }) || changed;
      }
    }
    if (changed) void this.persist();
  }

  private findOpenedSession(
    record: PersistedSessionOperation,
    sessions: ReturnType<SessionAccessRuntime['getSnapshot']>['sessions'],
  ) {
    const target = record.intent.target;
    if (target.kind === 'existing') {
      return sessions.find(
        (session) =>
          session.meta.sessionId === target.sessionId &&
          session.meta.kind === 'live' &&
          session.status !== 'ended',
      );
    }
    if (target.kind === 'offer') {
      return sessions.find((session) => session.meta.channelId === target.offerChannelId);
    }
    return sessions.find(
      (session) =>
        session.meta.kind === 'live' &&
        session.meta.addedAt >= record.createdAt &&
        session.meta.spawnedFromDeviceId === record.sourceDeviceId,
    );
  }

  /** Phone-side progress; never advances the Station revision used to fence takeover/cancel. */
  private setLocal(record: PersistedSessionOperation, patch: Partial<LifecycleStatusMsg>): boolean {
    const next: LifecycleStatusMsg = {
      ...record.status,
      ...patch,
      requestId: record.intent.requestId,
      revision: record.status.revision,
    };
    if (JSON.stringify(next) === JSON.stringify(record.status)) return false;
    record.status = next;
    return true;
  }

  private applySnapshot(record: PersistedSessionOperation, status: LifecycleStatusMsg): boolean {
    if (
      !isStatus(status, record.intent.requestId) ||
      (record.stationRevision !== undefined && status.revision < record.stationRevision) ||
      (record.stationRevision === status.revision && JSON.stringify(status) === JSON.stringify(record.status))
    ) {
      return false;
    }
    // A request this phone already finished (paired / cancelled) is not reopened by a late snapshot.
    if (record.status.outcome !== null && record.status.outcome !== 'failed' && status.outcome === null) {
      record.stationRevision = status.revision;
      return false;
    }
    record.status = status;
    record.stationRevision = status.revision;
    return true;
  }

  private missingOperation(requestId: string): LifecycleStatusMsg {
    return {
      requestId,
      revision: 0,
      stage: 'accepted',
      outcome: 'failed',
      reason: 'invalid-request',
      result: { message: 'The session request is no longer available.' },
    };
  }

  private async persist(): Promise<void> {
    const value = JSON.stringify({ operations: [...this.operations.values()] });
    const write = this.writeQueue.then(() => this.storage.setItem(SESSION_ACCESS_KEY, value));
    this.writeQueue = write.catch(() => {});
    await write;
  }
}
