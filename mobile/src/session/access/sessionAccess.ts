import {
  DEVICE_CAPABILITY,
  openIntentFingerprint,
  type LifecycleAction,
  type LifecycleFailureCode,
  type LifecycleOperationAction,
  type LifecycleState,
  type LifecycleStatusMsg,
  type OpenIntentMsg,
  type SpawnMode,
  type StructuredFailure,
  type TakeoverChallenge,
} from '@aasis21/weft-shared';
import { loadPendingOperations } from '@/lib/pendingOperations';
import {
  preferencesStorage,
  type PersistStorage,
} from '@/services/persistence/preferencesStorage';
import type { SessionRuntime } from '@/session/runtime/sessionRuntime';

const SESSION_ACCESS_KEY = 'weft.sessionAccess.v1';

export type SessionAccessTarget =
  | OpenIntentMsg['target']
  | { kind: 'offer'; offerChannelId: string };

export interface SessionOpenIntent {
  operationId?: string;
  deviceChannelId: string;
  target: SessionAccessTarget;
  mode?: SpawnMode;
  name?: string | null;
  title?: string | null;
  cwd?: string | null;
  takeoverRequested?: boolean;
}

interface NormalizedSessionOpenIntent extends SessionOpenIntent {
  operationId: string;
  mode: SpawnMode;
  name: string | null;
  title: string | null;
  cwd: string | null;
  takeoverRequested: boolean;
}

interface PersistedSessionOperation {
  intent: NormalizedSessionOpenIntent;
  fingerprint: string;
  status: LifecycleStatusMsg;
  runtimeCardId?: string;
  sourceDeviceId?: string;
}

export interface SessionAccessRuntime {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ReturnType<SessionRuntime['getSnapshot']>;
  setActive(channelId: string): void;
  spawnSession(
    channelId: string,
    opts: {
      projectName: string;
      mode: SpawnMode;
      name?: string;
      operationId?: string;
    },
  ): Promise<string>;
  resumeSession(
    channelId: string,
    opts: {
      sessionId: string;
      storeAuthority?: string | null;
      mode: SpawnMode;
      title?: string | null;
      cwd?: string | null;
      force?: boolean;
      operationId?: string;
    },
  ): Promise<string>;
  joinOfferedSession(deviceChannelId: string, offerChannelId: string): Promise<string>;
  retrySpawn(channelId: string): Promise<string | null>;
  remove(channelId: string): Promise<void>;
  getLifecycleStatus(operationId: string): LifecycleStatusMsg | null;
  confirmLifecycleTakeover(
    channelId: string,
    operationId: string,
    challengeId: string,
    revision: number,
  ): Promise<LifecycleStatusMsg>;
  cancelLifecycleOperation(
    channelId: string,
    operationId: string,
    revision: number,
  ): Promise<LifecycleStatusMsg>;
}

export interface SessionAccess {
  init(): Promise<void>;
  open(intent: SessionOpenIntent): Promise<LifecycleStatusMsg>;
  confirmTakeover(operationId: string): Promise<LifecycleStatusMsg>;
  cancel(operationId: string): Promise<LifecycleStatusMsg>;
  inspect(operationId: string): Promise<LifecycleStatusMsg | null>;
}

interface SessionAccessOptions {
  storage?: PersistStorage;
  clock?: () => number;
  randomId?: () => string;
}

type LifecycleStatusPatch = Partial<
  Omit<LifecycleStatusMsg, 'operationId' | 'fingerprint' | 'revision' | 'failure' | 'challenge'>
> & {
  failure?: StructuredFailure | null;
  challenge?: TakeoverChallenge | null;
};

function normalizeIntent(intent: SessionOpenIntent): NormalizedSessionOpenIntent {
  return {
    ...intent,
    operationId: intent.operationId?.trim() || `open-${crypto.randomUUID()}`,
    mode: intent.mode === 'allow-all' ? 'allow-all' : 'default',
    name: intent.target.kind === 'new' ? intent.name?.trim() || null : null,
    title: intent.title?.trim() || null,
    cwd: intent.cwd?.trim() || null,
    takeoverRequested: intent.target.kind === 'existing' && intent.takeoverRequested === true,
  };
}

async function fingerprint(intent: NormalizedSessionOpenIntent): Promise<string> {
  if (intent.target.kind !== 'offer') {
    return openIntentFingerprint({
      operationId: intent.operationId,
      target: intent.target,
      mode: intent.mode,
      name: intent.name,
      takeoverRequested: intent.takeoverRequested,
    });
  }
  return openIntentFingerprint({
    operationId: intent.operationId,
    target: {
      kind: 'existing',
      storeAuthority: 'legacy-offer',
      sessionId: intent.target.offerChannelId,
    },
    mode: intent.mode,
    name: null,
    takeoverRequested: false,
  });
}

function lifecycleMessage(code: LifecycleFailureCode): string {
  switch (code) {
    case 'controller-conflict':
      return 'This session is currently controlled by another phone.';
    case 'session-not-found':
      return 'This session is no longer available.';
    case 'project-not-found':
      return 'This project is no longer registered on the laptop.';
    case 'directory-not-found':
      return 'The session folder is no longer available.';
    case 'runtime-unavailable':
      return 'The laptop is not reachable right now.';
    case 'pairing-failed':
      return 'The session is ready, but the phone could not connect.';
    case 'timeout':
      return 'The laptop did not respond in time.';
    case 'cancelled':
      return 'The operation was cancelled.';
    case 'operation-conflict':
      return 'This operation ID was already used for a different request.';
    case 'operation-stale':
      return 'The operation changed before that action reached the laptop.';
    case 'target-reserved':
      return 'Another operation is already opening this session.';
    case 'unsupported':
      return 'This laptop needs a newer Weft version for that action.';
    case 'takeover-stale':
      return 'The session changed before takeover could be confirmed.';
    case 'takeover-failed':
      return 'The existing session could not be replaced safely.';
    case 'launch-outcome-unknown':
      return 'The laptop may have launched the session; Weft must reconcile it before retrying.';
    case 'launch-not-recoverable':
      return 'The prior launch could not be recovered safely.';
    case 'identity-failed':
      return 'The laptop could not create a secure session identity.';
    default:
      return 'The session could not be opened.';
  }
}

export function lifecycleFailureMessage(failure?: StructuredFailure): string {
  return failure?.message || lifecycleMessage(failure?.code ?? 'internal-error');
}

export function requiresTakeoverConfirmation(
  status: LifecycleStatusMsg,
): status is LifecycleStatusMsg & { challenge: TakeoverChallenge } {
  const challenge = status.challenge;
  return (
    status.failure?.actions.includes('confirm-takeover') === true &&
    typeof challenge?.challengeId === 'string' &&
    challenge.challengeId.length > 0 &&
    challenge.operationId === status.operationId &&
    challenge.revision === status.revision
  );
}

function legacyFailure(error: unknown): StructuredFailure {
  const message = error instanceof Error ? error.message : 'The session could not be opened.';
  if (/already (running|attached)|connected to a phone/i.test(message)) {
    return {
      code: 'controller-conflict',
      actions: ['confirm-takeover', 'cancel'],
      message,
    };
  }
  if (/folder|directory/i.test(message) && /(no longer exists|not found|missing)/i.test(message)) {
    return { code: 'directory-not-found', actions: ['choose-directory', 'cancel'], message };
  }
  if (/session offer is no longer available|session no longer exists|session.*not found/i.test(message)) {
    return { code: 'session-not-found', actions: ['choose-session', 'cancel'], message };
  }
  if (/timed out|timeout|has not answered yet/i.test(message)) {
    return { code: 'timeout', actions: ['retry', 'cancel'], message, retryable: true };
  }
  if (/not connected|could not reach|offline/i.test(message)) {
    return { code: 'runtime-unavailable', actions: ['retry', 'cancel'], message, retryable: true };
  }
  return { code: 'internal-error', actions: ['retry', 'cancel'], message, retryable: true };
}

function stateForStage(stage: string): LifecycleState {
  switch (stage) {
    case 'not-delivered':
      return 'accepted';
    case 'delivered':
    case 'launched':
      return 'launching';
    case 'ready':
      return 'pairing-ready';
    case 'pairing':
      return 'pairing';
    case 'pairing-failed':
      return 'failed';
    default:
      return 'accepted';
  }
}

function actionFor(intent: NormalizedSessionOpenIntent): LifecycleOperationAction {
  if (intent.takeoverRequested) return 'takeover';
  if (intent.target.kind === 'new') return 'start';
  if (intent.target.kind === 'offer') return 'activate';
  return 'resume';
}

function allowedActions(code: LifecycleFailureCode): LifecycleAction[] {
  switch (code) {
    case 'controller-conflict':
      return ['confirm-takeover', 'cancel'];
    case 'session-not-found':
      return ['choose-session', 'cancel'];
    case 'project-not-found':
    case 'directory-not-found':
      return ['choose-directory', 'cancel'];
    case 'unsupported':
      return ['update-peer', 'cancel'];
    case 'cancelled':
      return [];
    default:
      return ['retry', 'cancel'];
  }
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
    this.storage = options.storage ?? preferencesStorage;
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
    const intent = normalizeIntent({
      ...input,
      operationId: input.operationId?.trim() || `open-${this.randomId()}`,
    });
    const intentFingerprint = await fingerprint(intent);
    const previous = this.operations.get(intent.operationId);
    if (previous) {
      if (previous.fingerprint !== intentFingerprint) {
        return this.setFailure(previous, {
          code: 'operation-conflict',
          actions: [],
        });
      }
      return previous.status;
    }

    const now = this.clock();
    const record: PersistedSessionOperation = {
      intent,
      fingerprint: intentFingerprint,
      status: {
        operationId: intent.operationId,
        fingerprint: intentFingerprint,
        state: 'accepted',
        revision: 0,
        ...(intent.target.kind === 'offer' ? {} : { target: intent.target }),
        action: actionFor(intent),
        createdAt: now,
        updatedAt: now,
      },
    };
    const device = this.runtime.getSnapshot().devices.find((item) => item.channelId === intent.deviceChannelId);
    record.sourceDeviceId = device?.deviceId ?? intent.deviceChannelId;
    this.operations.set(intent.operationId, record);
    await this.persist();
    return this.execute(record);
  }

  async confirmTakeover(operationId: string): Promise<LifecycleStatusMsg> {
    await this.ensureLoaded();
    this.reconcileRuntime();
    const record = this.operations.get(operationId);
    if (!record) return this.missingOperation(operationId);
    if (
      record.intent.target.kind !== 'existing' ||
      !requiresTakeoverConfirmation(record.status)
    ) {
      return this.setFailure(record, {
        code: 'takeover-stale',
        actions: ['retry', 'cancel'],
      });
    }
    const device = this.runtime.getSnapshot().devices
      .find((item) => item.channelId === record.intent.deviceChannelId);
    if (device?.capabilities?.includes(DEVICE_CAPABILITY.SESSION_ACTIVATION_V1)) {
      const challenge = record.status.challenge;
      const status = await this.runtime.confirmLifecycleTakeover(
        record.intent.deviceChannelId,
        operationId,
        challenge.challengeId,
        record.status.revision,
      );
      this.applySnapshot(record, status);
      await this.persist();
      return record.status;
    }
    record.intent = { ...record.intent, takeoverRequested: true };
    this.update(record, {
      state: 'accepted',
      action: 'takeover',
      failure: null,
      challenge: null,
    });
    await this.persist();
    return this.execute(record);
  }

  async cancel(operationId: string): Promise<LifecycleStatusMsg> {
    await this.ensureLoaded();
    this.reconcileRuntime();
    const record = this.operations.get(operationId);
    if (!record) return this.missingOperation(operationId);
    const device = this.runtime.getSnapshot().devices
      .find((item) => item.channelId === record.intent.deviceChannelId);
    if (device?.capabilities?.includes(DEVICE_CAPABILITY.SESSION_ACTIVATION_V1)) {
      const status = await this.runtime.cancelLifecycleOperation(
        record.intent.deviceChannelId,
        operationId,
        record.status.revision,
      );
      this.applySnapshot(record, status);
      await this.persist();
      if (record.status.state === 'cancelled' && record.runtimeCardId) {
        await this.runtime.remove(record.runtimeCardId);
      }
      return record.status;
    }
    this.update(record, {
      state: 'cancelled',
      failure: {
        code: 'cancelled',
        actions: [],
        message: lifecycleMessage('cancelled'),
      },
      challenge: null,
    });
    await this.persist();
    if (record.runtimeCardId) await this.runtime.remove(record.runtimeCardId);
    return record.status;
  }

  async inspect(operationId: string): Promise<LifecycleStatusMsg | null> {
    await this.ensureLoaded();
    this.reconcileRuntime();
    return this.operations.get(operationId)?.status ?? null;
  }

  async retry(operationId: string): Promise<LifecycleStatusMsg> {
    await this.ensureLoaded();
    const record = this.operations.get(operationId);
    if (!record) return this.missingOperation(operationId);
    if (record.runtimeCardId) {
      this.update(record, { state: 'accepted', failure: null, challenge: null });
      await this.persist();
      await this.runtime.retrySpawn(record.runtimeCardId);
      this.reconcileRuntime();
      return record.status;
    }
    this.update(record, { state: 'accepted', failure: null, challenge: null });
    await this.persist();
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
          operationId: intent.operationId,
        });
      } else if (intent.target.kind === 'offer') {
        const device = this.runtime.getSnapshot().devices
          .find((item) => item.channelId === intent.deviceChannelId);
        cardId = device?.capabilities?.includes(DEVICE_CAPABILITY.SESSION_ACTIVATION_V1)
          ? await this.runtime.resumeSession(intent.deviceChannelId, {
              sessionId: intent.target.offerChannelId,
              storeAuthority: 'legacy-offer',
              mode: intent.mode,
              title: intent.title,
              operationId: intent.operationId,
            })
          : await this.runtime.joinOfferedSession(
              intent.deviceChannelId,
              intent.target.offerChannelId,
            );
      } else {
        cardId = await this.runtime.resumeSession(intent.deviceChannelId, {
          sessionId: intent.target.sessionId,
          mode: intent.mode,
          title: intent.title,
          cwd: intent.cwd,
          force: intent.takeoverRequested,
          operationId: intent.operationId,
        });
      }
      record.runtimeCardId = cardId;
      const session = this.runtime.getSnapshot().sessions.find((item) => item.meta.channelId === cardId);
      if (session?.meta.kind === 'spawning') {
        this.reconcileRuntime();
      } else {
        this.update(record, {
          state: 'open',
          action:
            intent.target.kind === 'existing' && !intent.takeoverRequested
              ? 'reconnect'
              : actionFor(intent),
          failure: null,
          challenge: null,
        });
        await this.persist();
      }
      return record.status;
    } catch (error) {
      const failure = legacyFailure(error);
      if (failure.code === 'controller-conflict' && record.intent.target.kind === 'existing') {
        const challenge: TakeoverChallenge = {
          challengeId: `legacy-${this.randomId()}`,
          operationId: record.intent.operationId,
          revision: record.status.revision + 1,
          storeAuthority: record.intent.target.storeAuthority,
          sessionId: record.intent.target.sessionId,
          runtimeInstanceId: `legacy-${record.intent.target.sessionId}`,
          generation: 0,
          pid: null,
          processStartedAt: null,
          responsive: false,
        };
        this.update(record, { state: 'failed', failure, challenge });
        await this.persist();
        return record.status;
      }
      return this.setFailure(record, failure);
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const raw = await this.storage.getItem(SESSION_ACCESS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { operations?: PersistedSessionOperation[] };
          for (const operation of parsed.operations ?? []) {
            if (
              operation?.intent?.operationId &&
              operation.status?.operationId === operation.intent.operationId
            ) {
              this.operations.set(operation.intent.operationId, operation);
            }
          }
        }
        const pending = await loadPendingOperations();
        for (const operation of pending) {
          if (this.operations.has(operation.requestId)) continue;
          const intent: NormalizedSessionOpenIntent = {
            operationId: operation.requestId,
            deviceChannelId: operation.deviceId,
            target: operation.kind === 'new'
              ? { kind: 'new', projectName: operation.projectName }
              : {
                  kind: 'existing',
                  storeAuthority: null,
                  sessionId: operation.sessionId ?? '',
                },
            mode: operation.mode,
            name: operation.name ?? null,
            title: operation.title ?? null,
            cwd: operation.cwd ?? null,
            takeoverRequested: operation.force === true,
          };
          const operationFingerprint = await fingerprint(intent);
          this.operations.set(operation.requestId, {
            intent,
            fingerprint: operationFingerprint,
            runtimeCardId: operation.tempId,
            sourceDeviceId: operation.spawnedFromDeviceId,
            status: {
              operationId: operation.requestId,
              fingerprint: operationFingerprint,
              state: stateForStage(operation.stage),
              revision: 0,
              ...(intent.target.kind === 'offer' ? {} : { target: intent.target }),
              action: actionFor(intent),
              createdAt: operation.createdAt,
              updatedAt: operation.createdAt,
              ...(operation.stage === 'pairing-failed'
                ? {
                    failure: {
                      code: 'pairing-failed' as const,
                      actions: allowedActions('pairing-failed'),
                      retryable: true,
                    },
                  }
                : {}),
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
      if (record.status.state === 'cancelled' || record.status.state === 'open') continue;
      const lifecycleStatus = this.runtime.getLifecycleStatus(record.intent.operationId);
      if (lifecycleStatus && lifecycleStatus.revision >= record.status.revision) {
        changed = this.applySnapshot(record, lifecycleStatus) || changed;
        if (
          lifecycleStatus.state === 'failed' ||
          lifecycleStatus.state === 'cancelled' ||
          lifecycleStatus.state === 'open'
        ) continue;
      }
      if (requiresTakeoverConfirmation(record.status)) continue;
      const spawning = snapshot.sessions.find(
        (session) => session.spawning?.requestId === record.intent.operationId,
      );
      if (spawning) {
        record.runtimeCardId = spawning.meta.channelId;
        if (spawning.error) {
          const failure = legacyFailure(new Error(spawning.error));
          changed = this.update(record, {
            state: 'failed',
            failure,
            ...(failure.code === 'controller-conflict' &&
            record.intent.target.kind === 'existing'
              ? {
                  challenge: {
                    challengeId: `legacy-${this.randomId()}`,
                    operationId: record.intent.operationId,
                    revision: record.status.revision + 1,
                    storeAuthority: record.intent.target.storeAuthority,
                    sessionId: record.intent.target.sessionId,
                    runtimeInstanceId: `legacy-${record.intent.target.sessionId}`,
                    generation: 0,
                    pid: null,
                    processStartedAt: null,
                    responsive: false,
                  },
                }
              : {}),
          }) || changed;
          continue;
        }
        const stage = spawning.spawning?.stage ?? 'not-delivered';
        changed = this.update(record, {
          state: stateForStage(stage),
          failure: stage === 'pairing-failed'
            ? {
                code: 'pairing-failed',
                actions: allowedActions('pairing-failed'),
                retryable: true,
              }
            : null,
        }) || changed;
        continue;
      }
      if (!record.runtimeCardId) continue;
      const opened = this.findOpenedSession(record, snapshot.sessions);
      if (opened) {
        record.runtimeCardId = opened.meta.channelId;
        changed = this.update(record, {
          state: 'open',
          failure: null,
          challenge: null,
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
        session.meta.addedAt >= (record.status.createdAt ?? 0) &&
        session.meta.spawnedFromDeviceId === record.sourceDeviceId,
    );
  }

  private update(
    record: PersistedSessionOperation,
    patch: LifecycleStatusPatch,
  ): boolean {
    const { failure, challenge, ...fields } = patch;
    const candidate: LifecycleStatusMsg = { ...record.status, ...fields };
    if (failure === null) delete candidate.failure;
    else if (failure !== undefined) candidate.failure = failure;
    if (challenge === null) delete candidate.challenge;
    else if (challenge !== undefined) candidate.challenge = challenge;
    if (
      candidate.state === record.status.state &&
      candidate.action === record.status.action &&
      JSON.stringify(candidate.failure) === JSON.stringify(record.status.failure) &&
      JSON.stringify(candidate.challenge) === JSON.stringify(record.status.challenge)
    ) {
      return false;
    }

    record.status = {
      ...candidate,
      operationId: record.intent.operationId,
      fingerprint: record.fingerprint,
      revision: record.status.revision + 1,
      updatedAt: this.clock(),
    };
    return true;
  }

  private applySnapshot(
    record: PersistedSessionOperation,
    status: LifecycleStatusMsg,
  ): boolean {
    if (
      status.operationId !== record.intent.operationId ||
      status.revision < record.status.revision ||
      JSON.stringify(status) === JSON.stringify(record.status)
    ) {
      return false;
    }
    record.status = status;
    return true;
  }

  private async setFailure(
    record: PersistedSessionOperation,
    failure: StructuredFailure,
  ): Promise<LifecycleStatusMsg> {
    this.update(record, {
      state: failure.code === 'cancelled' ? 'cancelled' : 'failed',
      failure: {
        ...failure,
        message: failure.message || lifecycleMessage(failure.code),
      },
    });
    await this.persist();
    return record.status;
  }

  private missingOperation(operationId: string): LifecycleStatusMsg {
    return {
      operationId,
      fingerprint: null,
      state: 'failed',
      revision: 0,
      failure: {
        code: 'invalid-request',
        actions: [],
        message: 'The session operation is no longer available.',
      },
      updatedAt: this.clock(),
    };
  }

  private async persist(): Promise<void> {
    const value = JSON.stringify({ operations: [...this.operations.values()] });
    const write = this.writeQueue.then(() => this.storage.setItem(SESSION_ACCESS_KEY, value));
    this.writeQueue = write.catch(() => {});
    await write;
  }
}
