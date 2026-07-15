import { useEffect, useRef, useState, type JSX } from 'react';
import {
  applyTheme,
  getSettings,
  setTheme,
  setVoiceAutoRelisten,
  setVoiceSpeakStreaming,
  type WeftSettings,
  type ThemeSetting,
} from '@/lib/settings';

interface SettingsScreenProps {
  onClose(): void;
  /** Version of the paired laptop's Weft extension, when the Settings screen is opened from a
   *  session or device context that knows it. Omitted from the Devices list (no single laptop). */
  laptopVersion?: string;
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

export function SettingsScreen({ onClose, laptopVersion }: SettingsScreenProps): JSX.Element {
  const appVersion = import.meta.env.VITE_APP_VERSION ?? 'dev';
  const [settings, setSettingsState] = useState<WeftSettings>({
    voiceAutoRelisten: false,
    voiceSpeakStreaming: false,
    theme: 'system',
  });
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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

  const toggleAutoRelisten = (enabled: boolean): void => {
    setSettingsState((current) => ({ ...current, voiceAutoRelisten: enabled }));
    void setVoiceAutoRelisten(enabled);
  };

  const toggleSpeakStreaming = (enabled: boolean): void => {
    setSettingsState((current) => ({ ...current, voiceSpeakStreaming: enabled }));
    void setVoiceSpeakStreaming(enabled);
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
            <div className="settings-row-head">
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
            <div className="settings-row-head">
              <div>
                <h2 id="settings-voice-title">Voice Mode</h2>
                <p>Hands-free conversation behavior after Weft speaks.</p>
              </div>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={settings.voiceAutoRelisten}
                  onChange={(event) => toggleAutoRelisten(event.currentTarget.checked)}
                />
                <span aria-hidden="true" />
              </label>
            </div>
            <span className="settings-row-label">Auto-relisten after the assistant speaks</span>

            <div className="settings-row-head">
              <div>
                <h2 id="settings-voice-stream-title">Stream spoken reply</h2>
                <p>On: speak words as they generate. Off: speak each reply once it's complete (more natural).</p>
              </div>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  aria-labelledby="settings-voice-stream-title"
                  checked={settings.voiceSpeakStreaming}
                  onChange={(event) => toggleSpeakStreaming(event.currentTarget.checked)}
                />
                <span aria-hidden="true" />
              </label>
            </div>
          </section>

          <section className="settings-group" aria-labelledby="settings-about-title">
            <div className="settings-row-head">
              <div>
                <h2 id="settings-about-title">About</h2>
                <p>Which Weft build this phone and the paired laptop are running.</p>
              </div>
            </div>
            <dl className="settings-about">
              <div className="settings-about-row">
                <dt>App version</dt>
                <dd>{appVersion}</dd>
              </div>
              <div className="settings-about-row">
                <dt>Laptop version</dt>
                <dd>{laptopVersion ?? 'Unknown'}</dd>
              </div>
            </dl>
          </section>
        </div>
      </section>
    </div>
  );
}
