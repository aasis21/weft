import type { DeviceSnapshotMsg, TransportDescriptor } from '@aasis21/weft-shared';
import { preferencesStorage } from '@/services/persistence/preferencesStorage';

const DEVICES_KEY = 'weft.devices.v1';
let mutationQueue: Promise<void> = Promise.resolve();

export interface DeviceHealthCache {
  capturedAt: number;
  effectiveIntervalMs: number;
  system: DeviceSnapshotMsg['system'];
  issues: DeviceSnapshotMsg['issues'];
}

export interface RegisteredDevice {
  channelId: string;
  /** Pairing protocol used by the listener. Missing means legacy version 1. */
  pairVersion?: 1 | 2;
  /** Listener public key from its LISTENER QR. */
  pub: string;
  /** Which transport + endpoint this listener was paired with — reused on reconnect via connectDevice. */
  transport: TransportDescriptor;
  /**
   * This phone's OWN ECDH keypair from the original pairing (mirrors StoredPairing). Reused
   * verbatim on every reconnect instead of minting a new keypair: the listener locks onto the
   * FIRST phone public key it sees per run (`boundPeerPub` in listener.mjs) and silently drops
   * any hello carrying a different key ("ignoring pairing from a different phone"). Without this,
   * every reconnect looked like a new/different phone and was rejected.
   */
  publicKeyB64: string;
  privateKeyJwk: JsonWebKey;
  name?: string;
  savedAt: number;
  isDefault?: boolean;
  lastProjectName?: string;
  /**
   * Stable, NON-SECRET id the listener persists across `weft start` restarts (see
   * extension/src/deviceIdentity.mjs), reported in its `project_list` reply. Unlike `channelId`
   * (a fresh pairing channel minted every listener run, by design, for forward secrecy), this id
   * lets the phone recognize "same laptop" across restarts so it can dedupe stale entries instead
   * of accumulating a new device row every time. Undefined until the first project_list arrives
   * (e.g. right after scanning the QR, before the listener has replied).
   */
  deviceId?: string;
  /** Last time this device was seen live (connected or sent a project list), epoch ms. */
  lastSeenAt?: number;
  /** The laptop's Weft version reported in its listener QR at pairing time. Optional — older
   *  laptops omit it. Surfaced on the phone's Settings page (Device details context). */
  appVersion?: string;
  /** Last successful system-health sample. Applications are intentionally excluded because their
   *  usage data remains runtime-only. */
  cachedHealth?: DeviceHealthCache;
}

function normalizeCachedHealth(value: unknown): DeviceHealthCache | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const health = value as Partial<DeviceHealthCache>;
  if (
    typeof health.capturedAt !== 'number' ||
    typeof health.effectiveIntervalMs !== 'number' ||
    !health.system ||
    typeof health.system !== 'object' ||
    !Array.isArray(health.issues)
  ) {
    return undefined;
  }
  return health as DeviceHealthCache;
}

function isRegisteredDevice(value: unknown): value is RegisteredDevice {
  if (!value || typeof value !== 'object') return false;
  const device = value as Partial<RegisteredDevice>;
  // Devices cached before the transport-descriptor / stable-identity refactors won't have
  // `transport`/`publicKeyB64`/`privateKeyJwk` — reject them here (rather than crash or silently
  // regenerate a mismatched identity on reconnect) so they're silently dropped; the user just
  // rescans the listener's QR to re-register with fresh, complete pairing material.
  return (
    typeof device.channelId === 'string' &&
    typeof device.pub === 'string' &&
    !!device.transport?.kind &&
    typeof device.publicKeyB64 === 'string' &&
    !!device.privateKeyJwk
  );
}

function normalize(parsed: unknown): RegisteredDevice[] {
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { devices?: unknown }).devices)
      ? (parsed as { devices: unknown[] }).devices
      : [];
  const byChannel = new Map<string, RegisteredDevice>();
  for (const item of raw) {
    if (!isRegisteredDevice(item)) continue;
    byChannel.set(item.channelId, {
      ...item,
      cachedHealth: normalizeCachedHealth(item.cachedHealth),
      savedAt: item.savedAt || Date.now(),
    });
  }
  const list = [...byChannel.values()];
  if (list.length > 0 && !list.some((d) => d.isDefault)) list[0] = { ...list[0], isDefault: true };
  return list;
}

async function read(): Promise<RegisteredDevice[]> {
  try {
    const raw = await preferencesStorage.getItem(DEVICES_KEY);
    if (!raw) return [];
    return normalize(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function write(list: RegisteredDevice[]): Promise<void> {
  const deduped = normalize(list);
  const value = JSON.stringify({ devices: deduped });
  await preferencesStorage.setItem(DEVICES_KEY, value);
}

export async function loadDevices(): Promise<RegisteredDevice[]> {
  await mutationQueue;
  return read();
}

function mutateDevices<T>(mutation: (list: RegisteredDevice[]) => Promise<[RegisteredDevice[], T]> | [RegisteredDevice[], T]): Promise<T> {
  const operation = mutationQueue.then(async () => {
    const [next, result] = await mutation(await read());
    await write(next);
    return result;
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function upsertDevice(device: RegisteredDevice): Promise<void> {
  await mutateDevices((list) => {
    const prior = list.find((d) => d.channelId === device.channelId);
    return [[
      ...list.filter((d) => d.channelId !== device.channelId),
      {
        ...prior,
        ...device,
        isDefault: device.isDefault ?? prior?.isDefault ?? list.length === 0,
      },
    ], undefined];
  });
}

export async function removeDevice(channelId: string): Promise<void> {
  await mutateDevices((list) => {
    const next = list.filter((d) => d.channelId !== channelId);
    if (next.length > 0 && !next.some((d) => d.isDefault)) next[0] = { ...next[0], isDefault: true };
    return [next, undefined];
  });
}

export async function setDefaultDevice(channelId: string): Promise<void> {
  await mutateDevices((list) => [
    list.map((d) => ({ ...d, isDefault: d.channelId === channelId })),
    undefined,
  ]);
}

export async function patchDevice(channelId: string, patch: Partial<Omit<RegisteredDevice, 'channelId'>>): Promise<void> {
  await mutateDevices((list) => {
    let changed = false;
    const next = list.map((d) => {
      if (d.channelId !== channelId) return d;
      changed = true;
      return { ...d, ...patch };
    });
    return [changed ? next : list, undefined];
  });
}

export interface ReconcileResult {
  /** channelIds of stale duplicate entries for the same physical device that were dropped. */
  removedChannelIds: string[];
  /** Fields folded into the surviving `channelId` entry (its own state plus anything inherited
   *  from the dropped duplicates: isDefault, lastProjectName, name). */
  merged: Pick<
    RegisteredDevice,
    'deviceId' | 'lastSeenAt' | 'isDefault' | 'lastProjectName' | 'name' | 'cachedHealth'
  >;
}

/**
 * Reconcile a listener's stable, non-secret `deviceId` (reported in its `project_list` reply)
 * against the persisted device list. Because `channelId` is a fresh ephemeral pairing channel
 * minted every `weft start` run (by design — see RegisteredDevice.deviceId), the SAME laptop
 * restarting its listener shows up under a brand-new channelId. This folds any OTHER persisted
 * entry sharing the same deviceId into the current `channelId` row — carrying over its
 * `isDefault`/`lastProjectName`/`name` — and drops the stale duplicate(s) so "Start another
 * session" never accumulates dead rows for a device that will never reconnect under its old id.
 */
export async function reconcileDeviceId(channelId: string, deviceId: string, now = Date.now()): Promise<ReconcileResult> {
  return mutateDevices((list) => {
    const current = list.find((d) => d.channelId === channelId);
    const stales = list.filter((d) => d.channelId !== channelId && d.deviceId === deviceId);
    const cachedHealth = [current, ...stales]
      .map((device) => device?.cachedHealth)
      .filter((health): health is DeviceHealthCache => Boolean(health))
      .sort((a, b) => b.capturedAt - a.capturedAt)[0];

    const merged: ReconcileResult['merged'] = {
      deviceId,
      lastSeenAt: now,
      isDefault: current?.isDefault || stales.some((d) => d.isDefault) || undefined,
      lastProjectName: current?.lastProjectName ?? stales.find((d) => d.lastProjectName)?.lastProjectName,
      name: current?.name ?? stales.find((d) => d.name)?.name,
      cachedHealth,
    };
    const removedChannelIds = stales.map((d) => d.channelId);
    const next = list
      .filter((d) => d.channelId === channelId || !removedChannelIds.includes(d.channelId))
      .map((d) => (d.channelId === channelId ? { ...d, ...merged } : d));
    return [next, { removedChannelIds, merged }];
  });
}
