import { Preferences } from '@capacitor/preferences';

export type ThemeSetting = 'system' | 'light' | 'dark';

export interface HelmSettings {
  voiceAutoRelisten: boolean;
  theme: ThemeSetting;
}

const SETTINGS_KEY = 'helm.settings.v1';
const DEFAULT_SETTINGS: HelmSettings = {
  voiceAutoRelisten: false,
  theme: 'system',
};
const SETTINGS_EVENT = 'helm-settings-change';

function parseSettings(raw: string | null | undefined): Partial<HelmSettings> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const record = parsed as Record<string, unknown>;
    const out: Partial<HelmSettings> = {};
    if (typeof record.voiceAutoRelisten === 'boolean') out.voiceAutoRelisten = record.voiceAutoRelisten;
    if (record.theme === 'light' || record.theme === 'dark' || record.theme === 'system') out.theme = record.theme;
    return out;
  } catch {
    return {};
  }
}

function normalize(settings: Partial<HelmSettings>): HelmSettings {
  return {
    voiceAutoRelisten: settings.voiceAutoRelisten ?? DEFAULT_SETTINGS.voiceAutoRelisten,
    theme: settings.theme ?? DEFAULT_SETTINGS.theme,
  };
}

async function readRawSettings(): Promise<Partial<HelmSettings>> {
  try {
    const { value } = await Preferences.get({ key: SETTINGS_KEY });
    if (value != null) return parseSettings(value);
  } catch {
    // Preferences may be unavailable in web tests; fall back to localStorage below.
  }
  try {
    return parseSettings(globalThis.localStorage?.getItem(SETTINGS_KEY));
  } catch {
    return {};
  }
}

async function writeSettings(settings: HelmSettings): Promise<void> {
  const value = JSON.stringify(settings);
  try {
    await Preferences.set({ key: SETTINGS_KEY, value });
  } catch {
    // Ignore — localStorage below still persists it for web.
  }
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, value);
  } catch {
    // localStorage can be unavailable; the in-memory UI still updates.
  }
  globalThis.dispatchEvent?.(new CustomEvent<HelmSettings>(SETTINGS_EVENT, { detail: settings }));
}

export async function getSettings(): Promise<HelmSettings> {
  return normalize(await readRawSettings());
}

export async function setSettings(next: HelmSettings): Promise<void> {
  await writeSettings(normalize(next));
}

export async function getVoiceAutoRelisten(): Promise<boolean> {
  return (await getSettings()).voiceAutoRelisten;
}

export async function setVoiceAutoRelisten(enabled: boolean): Promise<void> {
  const current = await getSettings();
  await writeSettings({ ...current, voiceAutoRelisten: enabled });
}

export async function getTheme(): Promise<ThemeSetting> {
  return (await getSettings()).theme;
}

export async function setTheme(theme: ThemeSetting): Promise<void> {
  const current = await getSettings();
  const next = { ...current, theme };
  await writeSettings(next);
  applyTheme(theme);
}

export function applyTheme(theme: ThemeSetting): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = theme;
}

export async function initTheme(): Promise<void> {
  applyTheme(await getTheme());
}

export function subscribeSettings(listener: (settings: HelmSettings) => void): () => void {
  const onChange = (event: Event): void => {
    const detail = (event as CustomEvent<HelmSettings>).detail;
    if (detail) listener(detail);
  };
  globalThis.addEventListener?.(SETTINGS_EVENT, onChange);
  return () => globalThis.removeEventListener?.(SETTINGS_EVENT, onChange);
}
