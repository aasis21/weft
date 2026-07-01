import { useEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { MODES } from '@aasis21/helm-shared';
import type { SessionMode } from '@aasis21/helm-shared';

interface ComposerProps {
  sessionId: string;
  disabled: boolean;
  busy: boolean;
  mode: SessionMode;
  cwd: string | null;
  onPrompt(text: string): Promise<void> | void;
  onInterrupt(): void;
  onModeChange(mode: SessionMode): Promise<void> | void;
}

const MODE_LABEL: Record<string, string> = {
  interactive: 'Interactive',
  plan: 'Plan',
  autopilot: 'Autopilot',
};

const DRAFT_KEY_PREFIX = 'helm.draft.v1.';

function draftKey(sessionId: string): string {
  return `${DRAFT_KEY_PREFIX}${sessionId}`;
}

function loadDraft(sessionId: string): string {
  try {
    return globalThis.localStorage?.getItem(draftKey(sessionId)) ?? '';
  } catch {
    return '';
  }
}

function saveDraft(sessionId: string, value: string): void {
  try {
    if (value) {
      globalThis.localStorage?.setItem(draftKey(sessionId), value);
    } else {
      globalThis.localStorage?.removeItem(draftKey(sessionId));
    }
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

function basename(path: string | null): string | null {
  if (!path) return null;
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function Composer({
  sessionId,
  disabled,
  busy,
  mode,
  cwd,
  onPrompt,
  onInterrupt,
  onModeChange,
}: ComposerProps): JSX.Element {
  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const modeWrapRef = useRef<HTMLDivElement | null>(null);
  const modeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  useEffect(() => {
    setText(loadDraft(sessionId));
  }, [sessionId]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDocMouseDown = (event: MouseEvent): void => {
      if (modeWrapRef.current && !modeWrapRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onDocKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        modeButtonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [menuOpen]);

  const send = async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    setText('');
    saveDraft(sessionId, '');
    await onPrompt(trimmed);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const onTextChange = (value: string): void => {
    setText(value);
    saveDraft(sessionId, value);
  };

  const folder = basename(cwd);

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="composer-toolbar">
        <div className="mode-wrap" ref={modeWrapRef}>
          <button
            ref={modeButtonRef}
            type="button"
            className="pill mode-pill"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span className="pill-dot" aria-hidden="true" />
            {MODE_LABEL[mode] ?? mode}
            <span className="pill-caret" aria-hidden="true">▾</span>
          </button>
          {menuOpen ? (
            <div className="mode-menu" role="menu">
              {MODES.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item === mode}
                  className={`mode-menu-item${item === mode ? ' active' : ''}`}
                  onClick={() => {
                    setMenuOpen(false);
                    if (item !== mode) void onModeChange(item);
                  }}
                >
                  <span className="mode-check">{item === mode ? '✓' : ''}</span>
                  {MODE_LABEL[item] ?? item}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {folder ? <span className="cwd-chip" title={cwd ?? undefined}>📁 {folder}</span> : null}
        <span className="composer-spacer" />
      </div>

      <div className="composer-input-row">
        <textarea
          ref={areaRef}
          rows={1}
          aria-label="Message your Copilot session"
          disabled={disabled}
          value={text}
          spellCheck={false}
          onKeyDown={onKeyDown}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder={disabled ? 'Session ended — re-pair to continue.' : 'Message your Copilot session…'}
        />
        {busy ? (
          <button
            className="stop-btn"
            type="button"
            onClick={onInterrupt}
            aria-label="Stop generating"
            title="Stop generating"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button className="send-btn" type="submit" disabled={disabled || !text.trim()} aria-label="Send">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M4 12l15-7-7 15-2-6-6-2z" />
            </svg>
          </button>
        )}
      </div>
    </form>
  );
}
