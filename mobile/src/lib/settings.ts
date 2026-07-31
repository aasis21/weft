import { Preferences } from '@capacitor/preferences';

export type ThemeSetting = 'system' | 'light' | 'dark';

export interface WeftSettings {
  voiceAutoRelisten: boolean;
  voiceSpeakStreaming: boolean;
  /**
   * Keep one recognition session open across pauses instead of letting the engine end at every
   * breath and reopening it. Off by default: Android's continuous mode revises and re-delivers
   * results, which garbles long dictation on some devices (#194).
   */
  voiceContinuous: boolean;
  /** Seconds of silence before Vox auto-sends what it heard. */
  voiceSilenceSeconds: number;
  /**
   * BCP-47 tag handed to the browser's speech recogniser, or '' for "whatever the phone's locale
   * says". Until this existed the recogniser silently took `navigator.language`, so a phone set to
   * US English transcribed Indian-accented English (never mind Hindi) against the wrong model and
   * there was no way to tell it otherwise. Set-once, so it lives in Settings rather than the
   * in-session Vox panel.
   */
  voiceLanguage: string;
  theme: ThemeSetting;
}

/** The languages offered in Settings. '' means "follow the phone", which stays the default so
 *  nobody who never opens this list sees a behaviour change. */
export const VOICE_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: '', label: 'Phone default' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-IN', label: 'English (India)' },
  { value: 'hi-IN', label: 'हिंदी' },
];

/** Bounds for {@link WeftSettings.voiceSilenceSeconds} — below 1s a breath sends; above 10s feels stuck. */
export const VOICE_SILENCE_MIN = 1;
export const VOICE_SILENCE_MAX = 10;

const SETTINGS_KEY = 'weft.settings.v1';
const DEFAULT_SETTINGS: WeftSettings = {
  voiceAutoRelisten: false,
  voiceSpeakStreaming: false,
  voiceContinuous: false,
  voiceSilenceSeconds: 3.2,
  voiceLanguage: '',
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
    if (typeof record.voiceContinuous === 'boolean') out.voiceContinuous = record.voiceContinuous;
    if (typeof record.voiceSilenceSeconds === 'number' && Number.isFinite(record.voiceSilenceSeconds)) {
      out.voiceSilenceSeconds = record.voiceSilenceSeconds;
    }
    if (typeof record.voiceLanguage === 'string') out.voiceLanguage = record.voiceLanguage;
    if (record.theme === 'light' || record.theme === 'dark' || record.theme === 'system') out.theme = record.theme;
    return out;
  } catch {
    return {};
  }
}

function clampSilence(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_SETTINGS.voiceSilenceSeconds;
  return Math.min(VOICE_SILENCE_MAX, Math.max(VOICE_SILENCE_MIN, Math.round(seconds * 10) / 10));
}

function normalize(settings: Partial<WeftSettings>): WeftSettings {
  return {
    voiceAutoRelisten: settings.voiceAutoRelisten ?? DEFAULT_SETTINGS.voiceAutoRelisten,
    voiceSpeakStreaming: settings.voiceSpeakStreaming ?? DEFAULT_SETTINGS.voiceSpeakStreaming,
    voiceContinuous: settings.voiceContinuous ?? DEFAULT_SETTINGS.voiceContinuous,
    voiceSilenceSeconds: clampSilence(settings.voiceSilenceSeconds ?? DEFAULT_SETTINGS.voiceSilenceSeconds),
    voiceLanguage: settings.voiceLanguage ?? DEFAULT_SETTINGS.voiceLanguage,
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

export async function getVoiceContinuous(): Promise<boolean> {
  return (await getSettings()).voiceContinuous;
}

export async function setVoiceContinuous(enabled: boolean): Promise<void> {
  const current = await getSettings();
  await writeSettings({ ...current, voiceContinuous: enabled });
}

export async function getVoiceSilenceSeconds(): Promise<number> {  return (await getSettings()).voiceSilenceSeconds;
}

export async function setVoiceSilenceSeconds(seconds: number): Promise<void> {
  const current = await getSettings();
  await writeSettings({ ...current, voiceSilenceSeconds: clampSilence(seconds) });
}

export async function getVoiceLanguage(): Promise<string> {
  return (await getSettings()).voiceLanguage;
}

export async function setVoiceLanguage(language: string): Promise<void> {
  const current = await getSettings();
  await writeSettings({ ...current, voiceLanguage: language });
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
