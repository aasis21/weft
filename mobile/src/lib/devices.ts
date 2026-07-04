import { Preferences } from '@capacitor/preferences';
import type { TransportDescriptor } from '@aasis21/helm-shared';

const DEVICES_KEY = 'helm.devices.v1';

export interface RegisteredDevice {
  channelId: string;
  /** Listener public key from its LISTENER QR. */
  pub: string;
  /** Which transport + endpoint this listener was paired with — reused on reconnect via connectDevice. */
  transport: TransportDescriptor;
  name?: string;
  savedAt: number;
  isDefault?: boolean;
  lastProjectName?: string;
  /**
   * Stable, NON-SECRET id the listener persists across `helm-cli start` restarts (see
   * extension/src/deviceIdentity.mjs), reported in its `project_list` reply. Unlike `channelId`
   * (a fresh pairing channel minted every listener run, by design, for forward secrecy), this id
   * lets the phone recognize "same laptop" across restarts so it can dedupe stale entries instead
   * of accumulating a new device row every time. Undefined until the first project_list arrives
   * (e.g. right after scanning the QR, before the listener has replied).
   */
  deviceId?: string;
  /** Last time this device was seen live (connected or sent a project list), epoch ms. */
  lastSeenAt?: number;
}

function isRegisteredDevice(value: unknown): value is RegisteredDevice {
  if (!value || typeof value !== 'object') return false;
  const device = value as Partial<RegisteredDevice>;
  // Devices cached before the transport-descriptor refactor won't have `transport` — reject them
  // here (rather than crash inside pairWithPublicKey on reconnect) so they're silently dropped;
  // the user just rescans the listener's QR to re-register with a fresh, transport-carrying payload.
  return typeof device.channelId === 'string' && typeof device.pub === 'string' && !!device.transport?.kind;
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
    byChannel.set(item.channelId, { ...item, savedAt: item.savedAt || Date.now() });
  }
  const list = [...byChannel.values()];
  if (list.length > 0 && !list.some((d) => d.isDefault)) list[0] = { ...list[0], isDefault: true };
  return list;
}

async function read(): Promise<RegisteredDevice[]> {
  try {
    const { value } = await Preferences.get({ key: DEVICES_KEY });
    const raw = value ?? globalThis.localStorage?.getItem(DEVICES_KEY);
    if (!raw) return [];
    return normalize(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function write(list: RegisteredDevice[]): Promise<void> {
  const deduped = normalize(list);
  const value = JSON.stringify({ devices: deduped });
  await Preferences.set({ key: DEVICES_KEY, value });
  globalThis.localStorage?.setItem(DEVICES_KEY, value);
}

export async function loadDevices(): Promise<RegisteredDevice[]> {
  return read();
}

export async function upsertDevice(device: RegisteredDevice): Promise<void> {
  const list = await read();
  const prior = list.find((d) => d.channelId === device.channelId);
  const next = [
    ...list.filter((d) => d.channelId !== device.channelId),
    {
      ...prior,
      ...device,
      isDefault: device.isDefault ?? prior?.isDefault ?? list.length === 0,
    },
  ];
  await write(next);
}

export async function removeDevice(channelId: string): Promise<void> {
  const list = (await read()).filter((d) => d.channelId !== channelId);
  if (list.length > 0 && !list.some((d) => d.isDefault)) list[0] = { ...list[0], isDefault: true };
  await write(list);
}

export async function setDefaultDevice(channelId: string): Promise<void> {
  const list = await read();
  await write(list.map((d) => ({ ...d, isDefault: d.channelId === channelId })));
}

export async function patchDevice(channelId: string, patch: Partial<Omit<RegisteredDevice, 'channelId'>>): Promise<void> {
  const list = await read();
  let changed = false;
  const next = list.map((d) => {
    if (d.channelId !== channelId) return d;
    changed = true;
    return { ...d, ...patch };
  });
  if (changed) await write(next);
}

export interface ReconcileResult {
  /** channelIds of stale duplicate entries for the same physical device that were dropped. */
  removedChannelIds: string[];
  /** Fields folded into the surviving `channelId` entry (its own state plus anything inherited
   *  from the dropped duplicates: isDefault, lastProjectName, name). */
  merged: Pick<RegisteredDevice, 'deviceId' | 'lastSeenAt' | 'isDefault' | 'lastProjectName' | 'name'>;
}

/**
 * Reconcile a listener's stable, non-secret `deviceId` (reported in its `project_list` reply)
 * against the persisted device list. Because `channelId` is a fresh ephemeral pairing channel
 * minted every `helm-cli start` run (by design — see RegisteredDevice.deviceId), the SAME laptop
 * restarting its listener shows up under a brand-new channelId. This folds any OTHER persisted
 * entry sharing the same deviceId into the current `channelId` row — carrying over its
 * `isDefault`/`lastProjectName`/`name` — and drops the stale duplicate(s) so "Start another
 * session" never accumulates dead rows for a device that will never reconnect under its old id.
 */
export async function reconcileDeviceId(channelId: string, deviceId: string, now = Date.now()): Promise<ReconcileResult> {
  const list = await read();
  const current = list.find((d) => d.channelId === channelId);
  const stales = list.filter((d) => d.channelId !== channelId && d.deviceId === deviceId);

  const merged: ReconcileResult['merged'] = {
    deviceId,
    lastSeenAt: now,
    isDefault: current?.isDefault || stales.some((d) => d.isDefault) || undefined,
    lastProjectName: current?.lastProjectName ?? stales.find((d) => d.lastProjectName)?.lastProjectName,
    name: current?.name ?? stales.find((d) => d.name)?.name,
  };

  if (stales.length === 0) {
    if (current) await patchDevice(channelId, { deviceId, lastSeenAt: now });
    return { removedChannelIds: [], merged };
  }

  const next = list
    .filter((d) => d.channelId === channelId || !stales.some((s) => s.channelId === d.channelId))
    .map((d) => (d.channelId === channelId ? { ...d, ...merged } : d));
  await write(next);
  return { removedChannelIds: stales.map((d) => d.channelId), merged };
}
