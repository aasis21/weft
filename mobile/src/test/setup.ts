// Global Vitest setup (jsdom). Runs before every test file.
//
// It does three things:
//   1. Registers @testing-library/jest-dom matchers (toBeInTheDocument, toHaveTextContent, ...).
//   2. Installs the module-boundary mocks that make the fast tier possible: an in-memory
//      @capacitor/preferences (so sessions/transcripts/storage run for real, no native bridge),
//      no-op @capacitor/app / @capacitor/local-notifications, and spied notifications.
//   3. Stubs the handful of browser APIs jsdom doesn't implement (Notification, matchMedia,
//      ResizeObserver, scroll*). None of this touches the network, WebCrypto, or Supabase.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { resetPreferences } from './helpers/mockPreferences';
import { registry } from './helpers/fakeWeftClient';

// --- Transport: FakeWeftClient replaces the real Supabase/WebCrypto client -----------------------
// SessionManager and demoSimulator import pairSession/connectSession from here; the fake records
// outbound sends and lets tests push inbound messages, with zero crypto or network.
vi.mock('../lib/weftClient', async () => {
  const { weftClientMock } = await import('./helpers/fakeWeftClient');
  return weftClientMock;
});

// --- Capacitor Preferences: real behaviour, in-memory store -------------------------------------
vi.mock('@capacitor/preferences', async () => {
  const { memoryPreferences } = await import('./helpers/mockPreferences');
  return { Preferences: memoryPreferences };
});

// --- Capacitor App: resume triggers become no-ops in tests --------------------------------------
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
    removeAllListeners: vi.fn().mockResolvedValue(undefined),
  },
}));

// --- Native local-notifications plugin never loads in jsdom (isNative() is false), but stub it so
//     a stray dynamic import can't fail. ------------------------------------------------------------
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: vi.fn().mockResolvedValue({ display: 'granted' }),
    requestPermissions: vi.fn().mockResolvedValue({ display: 'granted' }),
    schedule: vi.fn().mockResolvedValue(undefined),
    createChannel: vi.fn().mockResolvedValue(undefined),
  },
}));

// --- notifications module: spy on the "come look" alerts so scenarios can assert they fired,
//     without exercising the OS/Notification path. Tests import the module to read the spies. -------
vi.mock('../lib/notifications', () => ({
  ensureNotificationPermission: vi.fn().mockResolvedValue(true),
  notifyApprovalRequest: vi.fn().mockResolvedValue(undefined),
  notifyElicitationRequest: vi.fn().mockResolvedValue(undefined),
  notifySessionEnded: vi.fn().mockResolvedValue(undefined),
  appIsHidden: vi.fn().mockReturnValue(false),
  notificationIdFor: (id: string) => (id.length || 1) & 0x7fffffff,
  approvalNotification: () => ({ title: 'Copilot needs your approval', body: 'Allow an action?' }),
}));

// --- Browser APIs jsdom lacks --------------------------------------------------------------------
class NotificationStub {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn().mockResolvedValue('granted' as NotificationPermission);
  onclick: (() => void) | null = null;
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {}
  close(): void {}
}
Object.defineProperty(globalThis, 'Notification', {
  value: NotificationStub,
  configurable: true,
  writable: true,
});

if (!window.matchMedia) {
  // Plain function, NOT vi.fn() — the suite's `restoreMocks: true` calls
  // vi.restoreAllMocks() before every test, which wipes a vi.fn()'s
  // mockImplementation back to a no-op (returns undefined). This stub must
  // keep working test after test, so it can't be a mock itself.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);

// jsdom leaves these unimplemented; ChatThread auto-scrolls with them.
Element.prototype.scrollTo = Element.prototype.scrollTo ?? (vi.fn() as never);
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (vi.fn() as never);
window.scrollTo = window.scrollTo ?? (vi.fn() as never);

if (!('vibrate' in navigator)) {
  Object.defineProperty(navigator, 'vibrate', { value: vi.fn(), configurable: true });
}

// --- Clean persisted state between tests ---------------------------------------------------------
beforeEach(() => {
  resetPreferences();
  registry.reset();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  vi.clearAllTimers();
});
