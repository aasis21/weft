import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react';
import { sessionRuntime } from '@/session/runtime/instance';
import { deviceLabel, deviceStatus, sortDevices } from '@/ui/screens/deviceDisplay';
import { VoiceControls } from '@/ui/settings/VoiceControls';
import {
  applyTheme,
  getSettings,
  setTheme,
  type WeftSettings,
  type ThemeSetting,
} from '@/lib/settings';

interface SettingsScreenProps {
  onClose(): void;
  /** Version of the paired laptop's Weft extension, when the Settings screen is opened from a
   *  session or device context that knows it. Omitted from the Devices list (no single laptop). */
  laptopVersion?: string;
  /** Opens the host screen's drawer. Settings is a full screen like any other, so it gets the same
   *  hamburger; closing itself first keeps the drawer from opening underneath a modal. */
  onOpenDrawer?(): void;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isFocusable(element: HTMLElement): boolean {
  return element.tabIndex >= 0 && !element.hasAttribute('disabled') && element.getClientRects().length > 0;
}

const THEME_OPTIONS: Array<{ value: ThemeSetting; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** How each pairing transport reads to a human. The kind strings come straight off the pairing
 *  descriptor the laptop put in its QR (see TransportDescriptor in shared/transport.d.ts). */
const TRANSPORT_LABELS: Record<string, string> = {
  supabase: 'Supabase relay',
  devtunnel: 'Dev tunnel',
  local: 'Local',
};

export function SettingsScreen({ onClose, laptopVersion, onOpenDrawer }: SettingsScreenProps): JSX.Element {
  const appVersion = import.meta.env.VITE_APP_VERSION ?? 'dev';
  const [settings, setSettingsState] = useState<WeftSettings>({
    voiceAutoRelisten: false,
    voiceSpeakStreaming: false,
    voiceSilenceSeconds: 3.2,
    theme: 'system',
  });
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Read the devices straight off the runtime rather than threading a prop through all four call
  // sites: Settings opens from a session, a device, the devices list and the drawer, and only one
  // of those knows about a laptop at all.
  const snapshot = useSyncExternalStore(sessionRuntime.subscribe, sessionRuntime.getSnapshot);
  const deviceVersions = sortDevices(snapshot.devices).map((device) => ({
    channelId: device.channelId,
    name: deviceLabel(device),
    online: deviceStatus(device).tone !== 'offline',
    version: device.appVersion,
    transport: device.transport?.kind ? (TRANSPORT_LABELS[device.transport.kind] ?? device.transport.kind) : undefined,
  }));

  // Nearly every "it paired but nothing happens" report comes down to the two ends running
  // different builds, and until now the phone had no way to say so — the versions were listed side
  // by side and left for the reader to diff. Anything the laptop reports that isn't this build gets
  // called out explicitly.
  const mismatched = deviceVersions.some((device) => device.version && device.version !== appVersion);

  useEffect(() => {
    let cancelled = false;
    void getSettings().then((loaded) => {
      if (!cancelled) setSettingsState(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const active = document.activeElement;
    triggerRef.current = active instanceof HTMLElement ? active : null;

    const getFocusable = (): HTMLElement[] => {
      if (!overlayRef.current) return [];
      return Array.from(overlayRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusable);
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !overlayRef.current) return;
      const focusable = getFocusable();
      if (!focusable.length) {
        event.preventDefault();
        overlayRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (!first || !last) return;
      if (!overlayRef.current.contains(current)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const trigger = triggerRef.current;
      if (trigger && document.contains(trigger) && isFocusable(trigger)) trigger.focus();
    };
  }, []);

  const chooseTheme = (theme: ThemeSetting): void => {
    setSettingsState((current) => ({ ...current, theme }));
    applyTheme(theme);
    void setTheme(theme);
  };


  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      ref={overlayRef}
      tabIndex={-1}
    >
      <section className="settings-panel">
        <header className="settings-head">
          {onOpenDrawer ? (
            <button
              type="button"
              className="icon-btn settings-menu"
              onClick={() => {
                onClose();
                onOpenDrawer();
              }}
              aria-label="Open sessions"
              title="Sessions"
            >
              <span aria-hidden="true">☰</span>
            </button>
          ) : null}
          <div className="settings-head-text">
            <span className="settings-title">Settings</span>
            <span className="settings-sub">Theme, voice, and app preferences</span>
          </div>
          <button
            type="button"
            className="icon-btn settings-close"
            ref={closeButtonRef}
            onClick={onClose}
            aria-label="Close settings"
            title="Close"
          >
            ✕
          </button>
        </header>

        <div className="settings-groups">
          <section className="settings-group" aria-labelledby="settings-theme-title">
            <div className="settings-row-head settings-group-title">
              <div>
                <h2 id="settings-theme-title">Theme</h2>
                <p>Choose Weft's appearance on this device.</p>
              </div>
            </div>
            <div className="settings-segments" role="radiogroup" aria-label="Theme">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={settings.theme === option.value}
                  className={`settings-segment${settings.theme === option.value ? ' active' : ''}`}
                  onClick={() => chooseTheme(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-group" aria-labelledby="settings-voice-title">
            <VoiceControls showHeading />
          </section>

          <section className="settings-group" aria-labelledby="settings-about-title">
            <div className="settings-row-head settings-group-title">
              <div>
                <h2 id="settings-about-title">About</h2>
                <p>Which Weft build this phone and your paired laptops are running.</p>
              </div>
            </div>
            <dl className="settings-about">
              <div className="settings-about-row">
                <dt>This phone</dt>
                <dd>{appVersion}</dd>
              </div>
              {deviceVersions.length > 0 ? (
                deviceVersions.map((device) => (
                  <div className="settings-about-row" key={device.channelId}>
                    <dt>
                      <span className={`settings-device-dot${device.online ? ' online' : ''}`} aria-hidden="true" />
                      {device.name}
                      {device.transport ? <span className="settings-about-meta">{device.transport}</span> : null}
                    </dt>
                    <dd>{device.version ?? 'Unknown'}</dd>
                  </div>
                ))
              ) : (
                <div className="settings-about-row">
                  <dt>Laptop</dt>
                  <dd>{laptopVersion ?? 'Unknown'}</dd>
                </div>
              )}
            </dl>
            {mismatched ? (
              <p className="settings-about-warn" role="status">
                A paired laptop is on a different build than this phone. Reinstall the extension with{' '}
                <code>irm https://useweft.netlify.app/install.ps1 | iex</code> and reload this page.
              </p>
            ) : null}
          </section>
        </div>
      </section>
    </div>
  );
}
