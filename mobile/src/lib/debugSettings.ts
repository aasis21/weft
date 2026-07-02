import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';

const DEBUG_KEY = 'helm.debugMode.v1';

/** Read the persisted "show technical details on error" toggle. Defaults to off. Mirrors the
 *  Preferences + localStorage double-write pattern used elsewhere in lib/storage.ts so it works
 *  identically in the native shell and the hosted web app. */
export async function isDebugModeEnabled(): Promise<boolean> {
  try {
    const { value } = await Preferences.get({ key: DEBUG_KEY });
    if (value != null) return value === '1';
  } catch {
    // Preferences plugin unavailable (e.g. some web test environments) — fall through.
  }
  return globalThis.localStorage?.getItem(DEBUG_KEY) === '1';
}

export async function setDebugModeEnabled(enabled: boolean): Promise<void> {
  const value = enabled ? '1' : '0';
  try {
    await Preferences.set({ key: DEBUG_KEY, value });
  } catch {
    // Ignore — localStorage below still persists it for web.
  }
  globalThis.localStorage?.setItem(DEBUG_KEY, value);
}

/** Best-effort chain of `.cause` messages, so a wrapped transport error (e.g. the Supabase
 *  socket's generic CloseEvent/Error) surfaces every layer instead of just the outermost text. */
function causeChain(err: unknown): string[] {
  const out: string[] = [];
  let current: unknown = err;
  let guard = 0;
  while (current && guard < 5) {
    guard += 1;
    if (current instanceof Error) {
      out.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else if (typeof current === 'string') {
      out.push(current);
      break;
    } else if (typeof current === 'object') {
      try {
        out.push(JSON.stringify(current));
      } catch {
        out.push(String(current));
      }
      break;
    } else {
      break;
    }
  }
  return out;
}

/**
 * Build a multi-line technical detail block for a failed action (pairing, send, etc.) — the raw
 * `.cause` chain plus enough device/runtime context to tell "native app vs web" and "which build"
 * apart without needing a USB debugger. Only ever shown when the user has opted into debug mode.
 */
export function describeError(err: unknown, context: Record<string, string | undefined> = {}): string {
  const chain = causeChain(err);
  const lines = [
    `time: ${new Date().toISOString()}`,
    `platform: ${Capacitor.getPlatform()} (native=${Capacitor.isNativePlatform()})`,
    `transport: ${import.meta.env.VITE_HELM_TRANSPORT ?? 'local'}`,
    `userAgent: ${globalThis.navigator?.userAgent ?? 'n/a'}`,
    `online: ${globalThis.navigator?.onLine ?? 'n/a'}`,
    ...Object.entries(context)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${v}`),
    `error: ${chain[0] ?? String(err)}`,
    ...chain.slice(1).map((c, i) => `${'  '.repeat(i + 1)}caused by: ${c}`),
  ];
  return lines.join('\n');
}
