import { Preferences } from '@capacitor/preferences';
import type { PairingPayload, SpawnMode } from '@aasis21/weft-shared';

const PENDING_OPERATIONS_KEY = 'weft.pendingOperations.v1';
let mutationQueue: Promise<void> = Promise.resolve();

export type PendingOperationKind = 'new' | 'resume';
export type PendingOperationStage =
  | 'not-delivered'
  | 'delivered'
  | 'launched'
  | 'ready'
  | 'pairing'
  | 'pairing-failed';

export interface PendingPhoneIdentity {
  publicKeyB64: string;
  privateKeyJwk: JsonWebKey;
  deviceId: string;
}

export interface PendingOperation {
  requestId: string;
  tempId: string;
  kind: PendingOperationKind;
  deviceId: string;
  spawnedFromDeviceId: string;
  spawnedFromDeviceName?: string;
  projectName: string;
  name?: string;
  mode: SpawnMode;
  sessionId?: string;
  cwd?: string;
  title?: string;
  force?: boolean;
  createdAt: number;
  stage: PendingOperationStage;
  pairingPayload?: PairingPayload;
  phoneIdentity?: PendingPhoneIdentity;
}

function isPendingOperation(value: unknown): value is PendingOperation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PendingOperation>;
  return (
    typeof candidate.requestId === 'string' &&
    candidate.requestId.length > 0 &&
    typeof candidate.tempId === 'string' &&
    candidate.tempId.length > 0 &&
    (candidate.kind === 'new' || candidate.kind === 'resume') &&
    typeof candidate.deviceId === 'string' &&
    candidate.deviceId.length > 0 &&
    typeof candidate.projectName === 'string' &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.stage === 'string'
  );
}

async function read(): Promise<PendingOperation[]> {
  try {
    const { value } = await Preferences.get({ key: PENDING_OPERATIONS_KEY });
    const raw = globalThis.localStorage?.getItem(PENDING_OPERATIONS_KEY) ?? value;
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { operations?: unknown };
    return Array.isArray(parsed?.operations) ? parsed.operations.filter(isPendingOperation) : [];
  } catch {
    return [];
  }
}

async function write(operations: PendingOperation[]): Promise<void> {
  const value = JSON.stringify({ operations });
  try {
    globalThis.localStorage?.setItem(PENDING_OPERATIONS_KEY, value);
  } catch {
    // Preferences remains the primary native store.
  }
  try {
    await Preferences.set({ key: PENDING_OPERATIONS_KEY, value });
  } catch {
    // The localStorage mirror still covers the hosted app.
  }
}

export async function loadPendingOperations(): Promise<PendingOperation[]> {
  return read();
}

export async function upsertPendingOperation(operation: PendingOperation): Promise<void> {
  const update = mutationQueue.then(async () => {
    const operations = await read();
    await write([...operations.filter((item) => item.requestId !== operation.requestId), operation]);
  });
  mutationQueue = update.catch(() => {});
  await update;
}

export async function removePendingOperation(requestId: string): Promise<void> {
  const update = mutationQueue.then(async () => {
    const operations = await read();
    await write(operations.filter((item) => item.requestId !== requestId));
  });
  mutationQueue = update.catch(() => {});
  await update;
}
