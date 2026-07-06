import { Preferences } from '@capacitor/preferences';

export type ThemeSetting = 'system' | 'light' | 'dark';

export interface WeftSettings {
  voiceAutoRelisten: boolean;
  voiceSpeakStreaming: boolean;
  theme: ThemeSetting;
}

const SETTINGS_KEY = 'weft.settings.v1';
const DEFAULT_SETTINGS: WeftSettings = {
  voiceAutoRelisten: false,
  voiceSpeakStreaming: false,
  theme: 'system',
};
const SETTINGS_EVENT = 'weft-settings-change';

function parseSettings(raw: string | null | undefined): Partial<WeftSettings> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const record = parsed as Record<string, unknown>;
    const out: Partial<WeftSettings> = {};
    if (typeof record.voiceAutoRelisten === 'boolean') out.voiceAutoRelisten = record.voiceAutoRelisten;
    if (typeof record.voiceSpeakStreaming === 'boolean') out.voiceSpeakStreaming = record.voiceSpeakStreaming;
    if (record.theme === 'light' || record.theme === 'dark' || record.theme === 'system') out.theme = record.theme;
    return out;
  } catch {
    return {};
  }
}

function normalize(settings: Partial<WeftSettings>): WeftSettings {
  return {
    voiceAutoRelisten: settings.voiceAutoRelisten ?? DEFAULT_SETTINGS.voiceAutoRelisten,
    voiceSpeakStreaming: settings.voiceSpeakStreaming ?? DEFAULT_SETTINGS.voiceSpeakStreaming,
    theme: settings.theme ?? DEFAULT_SETTINGS.theme,
  };
}

async function readRawSettings(): Promise<Partial<WeftSettings>> {
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

async function writeSettings(settings: WeftSettings): Promise<void> {
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
  globalThis.dispatchEvent?.(new CustomEvent<WeftSettings>(SETTINGS_EVENT, { detail: settings }));
}

export async function getSettings(): Promise<WeftSettings> {
  return normalize(await readRawSettings());
}

export async function setSettings(next: WeftSettings): Promise<void> {
  await writeSettings(normalize(next));
}

export async function getVoiceAutoRelisten(): Promise<boolean> {
  return (await getSettings()).voiceAutoRelisten;
}

export async function setVoiceAutoRelisten(enabled: boolean): Promise<void> {
  const current = await getSettings();
  await writeSettings({ ...current, voiceAutoRelisten: enabled });
}

export async function getVoiceSpeakStreaming(): Promise<boolean> {
  return (await getSettings()).voiceSpeakStreaming;
}

export async function setVoiceSpeakStreaming(enabled: boolean): Promise<void> {
  const current = await getSettings();
  await writeSettings({ ...current, voiceSpeakStreaming: enabled });
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

export function subscribeSettings(listener: (settings: WeftSettings) => void): () => void {
  const onChange = (event: Event): void => {
    const detail = (event as CustomEvent<WeftSettings>).detail;
    if (detail) listener(detail);
  };
  globalThis.addEventListener?.(SETTINGS_EVENT, onChange);
  return () => globalThis.removeEventListener?.(SETTINGS_EVENT, onChange);
}
