import { Preferences } from '@capacitor/preferences';

const DEVICES_KEY = 'helm.devices.v1';

export interface RegisteredDevice {
  channelId: string;
  /** Listener public key from its LISTENER QR. */
  pub: string;
  name?: string;
  savedAt: number;
  isDefault?: boolean;
  lastProjectName?: string;
}

function isRegisteredDevice(value: unknown): value is RegisteredDevice {
  if (!value || typeof value !== 'object') return false;
  const device = value as Partial<RegisteredDevice>;
  return typeof device.channelId === 'string' && typeof device.pub === 'string';
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
