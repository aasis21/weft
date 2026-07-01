import '../composer.css';

import { useEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { MODES } from '@aasis21/helm-shared';
import type { SessionMode } from '@aasis21/helm-shared';
import { useSpeechInput } from '../lib/useSpeechInput';

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

interface SlashCommand {
  command: string;
  template: string;
}

const MODE_LABEL: Record<string, string> = {
  interactive: 'Interactive',
  plan: 'Plan',
  autopilot: 'Autopilot',
};

const SLASH_COMMANDS: SlashCommand[] = [
  {
    command: '/plan',
    template: 'Create a step-by-step plan before implementing the following, and wait for my approval: ',
  },
  {
    command: '/explain',
    template: 'Explain how the following works in detail: ',
  },
  {
    command: '/test',
    template: 'Write tests for ',
  },
  {
    command: '/fix',
    template: 'Find and fix the bug in ',
  },
  {
    command: '/review',
    template: 'Review the following code for bugs, security, and clarity: ',
  },
  {
    command: '/commit',
    template: 'Stage all changes and commit with a clear, conventional message.',
  },
];

const DRAFT_KEY_PREFIX = 'helm.draft.v1.';
const ENTER_SENDS_KEY = 'helm.enterSends.v1';

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

function loadEnterSends(): boolean {
  try {
    return globalThis.localStorage?.getItem(ENTER_SENDS_KEY) !== 'false';
  } catch {
    return true;
  }
}

function saveEnterSends(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(ENTER_SENDS_KEY, value ? 'true' : 'false');
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

function basename(path: string | null): string | null {
  if (!path) return null;
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function slashQuery(value: string): string | null {
  if (!value.startsWith('/')) return null;
  const firstToken = value.split(/\s/, 1)[0] ?? '';
  if (value !== firstToken || !/^\/[a-z]*$/i.test(firstToken)) return null;
  return firstToken.slice(1).toLowerCase();
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
  const [queued, setQueued] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [enterSends, setEnterSends] = useState(loadEnterSends);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const fullscreenAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const modeWrapRef = useRef<HTMLDivElement | null>(null);
  const modeButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasBusyRef = useRef(busy);
  const speechCommittedRef = useRef('');
  const speech = useSpeechInput();

  const onTextChange = (value: string): void => {
    setText(value);
    setSlashDismissed(false);
    saveDraft(sessionId, value);
  };

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
    if (!fullscreenOpen) return;
    window.requestAnimationFrame(() => fullscreenAreaRef.current?.focus());
  }, [fullscreenOpen]);

  useEffect(() => {
    if (wasBusyRef.current && !busy && queued.length > 0) {
      const pending = queued;
      setQueued([]);
      if (!disabled) pending.forEach((item) => void onPrompt(item));
    }
    wasBusyRef.current = busy;
  }, [busy, disabled, onPrompt, queued]);

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

  const commandQuery = slashQuery(text);
  const slashOptions = commandQuery === null
    ? []
    : SLASH_COMMANDS.filter((item) => item.command.slice(1).startsWith(commandQuery));
  const slashOpen = commandQuery !== null && slashOptions.length > 0 && !slashDismissed;

  useEffect(() => {
    setSlashIndex(0);
  }, [commandQuery]);

  const send = async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    if (speech.listening) speech.stop();
    setText('');
    setSlashDismissed(false);
    saveDraft(sessionId, '');
    if (busy) {
      setQueued((items) => [...items, trimmed]);
      return;
    }
    await onPrompt(trimmed);
  };

  const selectSlashCommand = (item: SlashCommand): void => {
    const next = text.replace(/^\/[a-z]*/i, item.template);
    onTextChange(next);
    setSlashDismissed(true);
    window.requestAnimationFrame(() => areaRef.current?.focus());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setSlashIndex((index) => (index + direction + slashOptions.length) % slashOptions.length);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const item = slashOptions[slashIndex];
        if (item) selectSlashCommand(item);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }

    if (event.key !== 'Enter') return;
    const shouldSend = enterSends ? !event.shiftKey : event.ctrlKey || event.metaKey;
    if (!shouldSend) return;
    event.preventDefault();
    void send();
  };

  const onFullscreenKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setFullscreenOpen(false);
      return;
    }
    onKeyDown(event);
  };

  const toggleEnterSends = (): void => {
    setEnterSends((value) => {
      const next = !value;
      saveEnterSends(next);
      return next;
    });
  };

  const toggleSpeech = (): void => {
    if (speech.listening) {
      speech.stop();
      return;
    }
    speechCommittedRef.current = text;
    speech.start((spokenText, isFinal) => {
      const committed = speechCommittedRef.current;
      const next = committed ? `${committed} ${spokenText}` : spokenText;
      if (isFinal) speechCommittedRef.current = next;
      onTextChange(next);
    });
  };

  const removeQueued = (index: number): void => {
    setQueued((items) => items.filter((_, itemIndex) => itemIndex !== index));
  };

  const focusMenuItem = (direction: 1 | -1): void => {
    const items = Array.from(modeWrapRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    if (!items.length) return;
    const active = document.activeElement;
    const index = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
    items[(index + direction + items.length) % items.length]?.focus();
  };

  const onModeButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setMenuOpen(true);
    window.requestAnimationFrame(() => focusMenuItem(event.key === 'ArrowDown' ? 1 : -1));
  };

  const onModeMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusMenuItem(event.key === 'ArrowDown' ? 1 : -1);
    }
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
            onKeyDown={onModeButtonKeyDown}
          >
            <span className="pill-dot" aria-hidden="true" />
            {MODE_LABEL[mode] ?? mode}
            <span className="pill-caret" aria-hidden="true">▾</span>
          </button>
          {menuOpen ? (
            <div className="mode-menu" role="menu" onKeyDown={onModeMenuKeyDown}>
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
        <button
          type="button"
          className={`enter-toggle${enterSends ? ' active' : ''}`}
          aria-pressed={enterSends}
          title="Enter sends"
          onClick={toggleEnterSends}
        >
          Enter sends
        </button>
        {folder ? <span className="cwd-chip" title={cwd ?? undefined}>📁 {folder}</span> : null}
        <span className="composer-spacer" />
        <button
          type="button"
          className="expand-btn"
          aria-label="Expand editor"
          title="Expand editor"
          onClick={() => setFullscreenOpen(true)}
          disabled={disabled}
        >
          ⤢
        </button>
      </div>

      {busy ? <div className="busy-hint">Agent is working — send now to queue a follow-up.</div> : null}

      {queued.length > 0 ? (
        <div className="queued-row" aria-label="Queued messages">
          {queued.map((item, index) => (
            <span className="queued-chip" key={`${item}-${index}`}>
              <span className="queued-text">{item}</span>
              <button
                type="button"
                className="queued-remove"
                aria-label="Remove queued message"
                onClick={() => removeQueued(index)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {slashOpen ? (
        <div className="slash-menu" role="listbox" aria-label="Slash command suggestions">
          {slashOptions.map((item, index) => (
            <button
              key={item.command}
              type="button"
              role="option"
              aria-selected={index === slashIndex}
              className={`slash-item${index === slashIndex ? ' active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectSlashCommand(item)}
            >
              <span className="slash-command">{item.command}</span>
              <span className="slash-template">{item.template}</span>
            </button>
          ))}
        </div>
      ) : null}

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
        {speech.supported && !disabled ? (
          <button
            className={`mic-btn${speech.listening ? ' listening' : ''}`}
            type="button"
            onClick={toggleSpeech}
            aria-label={speech.listening ? 'Stop voice input' : 'Start voice input'}
            title={speech.listening ? 'Stop voice input' : 'Start voice input'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M12 14a3 3 0 003-3V6a3 3 0 00-6 0v5a3 3 0 003 3zm5-3a1 1 0 10-2 0 3 3 0 01-6 0 1 1 0 10-2 0 5 5 0 004 4.9V19H8a1 1 0 100 2h8a1 1 0 100-2h-3v-3.1A5 5 0 0017 11z" />
            </svg>
          </button>
        ) : null}
        {busy ? (
          <>
            <button
              className="send-btn queue-btn"
              type="submit"
              disabled={disabled || !text.trim()}
              aria-label="Queue message"
              title="Queue message"
            >
              Queue
            </button>
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
          </>
        ) : (
          <button className="send-btn" type="submit" disabled={disabled || !text.trim()} aria-label="Send">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M4 12l15-7-7 15-2-6-6-2z" />
            </svg>
          </button>
        )}
      </div>

      {fullscreenOpen ? (
        <div className="composer-fullscreen" role="dialog" aria-modal="true" aria-label="Expanded composer editor">
          <div className="composer-fullscreen-panel">
            <div className="composer-fullscreen-header">
              <span>Expanded editor</span>
              <button
                type="button"
                className="composer-fullscreen-close"
                aria-label="Close editor"
                onClick={() => setFullscreenOpen(false)}
              >
                Done
              </button>
            </div>
            <textarea
              ref={fullscreenAreaRef}
              className="composer-fullscreen-textarea"
              aria-label="Expanded message editor"
              disabled={disabled}
              value={text}
              spellCheck={false}
              onKeyDown={onFullscreenKeyDown}
              onChange={(event) => onTextChange(event.target.value)}
            />
            <div className="composer-fullscreen-actions">
              <button
                type="button"
                className="send-btn composer-fullscreen-send"
                disabled={disabled || !text.trim()}
                aria-label={busy ? 'Queue message' : 'Send'}
                onClick={() => {
                  void send();
                  setFullscreenOpen(false);
                }}
              >
                {busy ? 'Queue message' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}
