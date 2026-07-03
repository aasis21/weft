import '@/ui/styles/composer.css';

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent } from 'react';
import { MODES } from '@aasis21/helm-shared';
import type { PromptAttachment, SessionMode } from '@aasis21/helm-shared';
import { useSpeechInput } from '@/ui/hooks/useSpeechInput';
import { ACCEPTED_IMAGE_TYPES, attachmentSrc, fileToAttachment } from '@/lib/imageAttachments';

interface ComposerProps {
  sessionId: string;
  disabled: boolean;
  disabledReason?: 'ended' | 'offline';
  busy: boolean;
  mode: SessionMode;
  cwd: string | null;
  onPrompt(text: string, attachments?: PromptAttachment[]): Promise<void> | void;
  onInterrupt(): void;
  onModeChange(mode: SessionMode): Promise<void> | void;
  onOpenVoiceMode(): void;
}

/** Max images per message — keeps the encrypted relay payload under the transport cap. */
const MAX_ATTACHMENTS = 6;

interface SlashCommand {
  command: string;
  template: string;
}

function appendSpeechText(committed: string, fresh: string): string {
  const base = committed.trimEnd();
  const tail = fresh.trim();
  if (!tail) return committed;
  if (!base) return tail;
  const normalizedBase = base.toLowerCase();
  const normalizedTail = tail.toLowerCase();
  const max = Math.min(normalizedBase.length, normalizedTail.length);
  for (let size = max; size > 0; size -= 1) {
    if (normalizedBase.endsWith(normalizedTail.slice(0, size))) {
      const remainder = tail.slice(size).trimStart();
      return remainder ? `${base} ${remainder}` : base;
    }
  }
  return `${base} ${tail}`;
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
const ATTACHMENTS_KEY_PREFIX = 'helm.draft-attachments.v1.';
const SEND_AFTER_STOP_SUPPRESS_MS = 500;

function draftKey(sessionId: string): string {
  return `${DRAFT_KEY_PREFIX}${sessionId}`;
}

function attachmentsKey(sessionId: string): string {
  return `${ATTACHMENTS_KEY_PREFIX}${sessionId}`;
}

function isPromptAttachment(value: unknown): value is PromptAttachment {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PromptAttachment>;
  return typeof item.data === 'string' && typeof item.mimeType === 'string' && typeof item.name === 'string';
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

function loadAttachments(sessionId: string): PromptAttachment[] {
  try {
    const raw = globalThis.localStorage?.getItem(attachmentsKey(sessionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPromptAttachment).slice(0, MAX_ATTACHMENTS) : [];
  } catch {
    return [];
  }
}

function saveAttachments(sessionId: string, value: PromptAttachment[]): void {
  try {
    if (value.length) {
      globalThis.localStorage?.setItem(attachmentsKey(sessionId), JSON.stringify(value.slice(0, MAX_ATTACHMENTS)));
    } else {
      globalThis.localStorage?.removeItem(attachmentsKey(sessionId));
    }
  } catch {
    // localStorage can be unavailable or full; keep the in-memory draft usable.
  }
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
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
  disabledReason,
  busy,
  mode,
  cwd,
  onPrompt,
  onInterrupt,
  onModeChange,
  onOpenVoiceMode,
}: ComposerProps): JSX.Element {
  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachWrapRef = useRef<HTMLDivElement | null>(null);
  const attachButtonRef = useRef<HTMLButtonElement | null>(null);
  const modeWrapRef = useRef<HTMLDivElement | null>(null);
  const modeButtonRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const speechCommittedRef = useRef('');
  const sessionIdRef = useRef(sessionId);
  const attachmentGenerationRef = useRef(0);
  const actionPointerStartedBusyRef = useRef(false);
  const disabledPlaceholder =
    disabledReason === 'offline'
      ? 'Reconnecting… — hold on'
      : 'Session ended — re-pair to continue.';
  const suppressSendUntilRef = useRef(0);
  const speech = useSpeechInput();
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [attachingCount, setAttachingCount] = useState(0);
  const [attachError, setAttachError] = useState<string | null>(null);
  const attaching = attachingCount > 0;
  sessionIdRef.current = sessionId;

  const applyTextChange = (targetSessionId: string, value: string): void => {
    if (sessionIdRef.current !== targetSessionId) return;
    setText(value);
    setSlashDismissed(false);
    saveDraft(targetSessionId, value);
  };

  const onTextChange = (value: string): void => {
    applyTextChange(sessionId, value);
  };

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => {
    attachmentGenerationRef.current += 1;
    speech.stop();
    speechCommittedRef.current = '';
    setText(loadDraft(sessionId));
    setAttachments(loadAttachments(sessionId));
    setAttachingCount(0);
    setAttachMenuOpen(false);
    setAttachError(null);
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

  useEffect(() => {
    if (!attachMenuOpen) return undefined;
    const onDocMouseDown = (event: MouseEvent): void => {
      if (attachWrapRef.current && !attachWrapRef.current.contains(event.target as Node)) setAttachMenuOpen(false);
    };
    const onDocKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setAttachMenuOpen(false);
        attachButtonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [attachMenuOpen]);

  const commandQuery = slashQuery(text);
  const slashOptions = commandQuery === null
    ? []
    : SLASH_COMMANDS.filter((item) => item.command.slice(1).startsWith(commandQuery));
  const slashOpen = commandQuery !== null && slashOptions.length > 0 && !slashDismissed;

  useEffect(() => {
    setSlashIndex(0);
  }, [commandQuery]);

  const send = async (): Promise<void> => {
    if (nowMs() < suppressSendUntilRef.current) return;
    const trimmed = text.trim();
    const outgoing = attachments;
    if ((!trimmed && outgoing.length === 0) || disabled || busy || attaching) return;
    if (speech.listening) speech.stop();
    setText('');
    setAttachments([]);
    setAttachError(null);
    setSlashDismissed(false);
    saveDraft(sessionId, '');
    saveAttachments(sessionId, []);
    await onPrompt(trimmed, outgoing.length ? outgoing : undefined);
  };

  const openFilePicker = (): void => {
    setAttachError(null);
    setAttachMenuOpen(false);
    fileInputRef.current?.click();
  };

  const openCameraPicker = (): void => {
    setAttachError(null);
    setAttachMenuOpen(false);
    cameraInputRef.current?.click();
  };

  const onFilesPicked = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = event.target;
    const files = Array.from(input.files ?? []);
    input.value = ''; // let the user re-pick the same file after removing it
    if (!files.length) return;
    const pickedSessionId = sessionId;
    const generation = attachmentGenerationRef.current;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setAttachError(`Up to ${MAX_ATTACHMENTS} images per message.`);
      return;
    }
    setAttachingCount((count) => count + 1);
    setAttachError(null);
    try {
      const picked = files.slice(0, room);
      const next: PromptAttachment[] = [];
      let failed = 0;
      for (const file of picked) {
        try {
          next.push(await fileToAttachment(file));
        } catch {
          failed += 1;
        }
      }
      if (generation !== attachmentGenerationRef.current || sessionIdRef.current !== pickedSessionId) return;
      if (next.length) {
        setAttachments((prev) => {
          const updated = [...prev, ...next].slice(0, MAX_ATTACHMENTS);
          saveAttachments(pickedSessionId, updated);
          return updated;
        });
      }
      if (failed) setAttachError(`Couldn't attach ${failed} image${failed > 1 ? 's' : ''}.`);
      else if (files.length > room) setAttachError(`Only ${room} more image${room > 1 ? 's' : ''} fit.`);
    } finally {
      setAttachingCount((count) => Math.max(0, count - 1));
    }
  };

  const removeAttachment = (index: number): void => {
    setAttachments((prev) => {
      const updated = prev.filter((_, i) => i !== index);
      saveAttachments(sessionId, updated);
      return updated;
    });
    setAttachError(null);
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
    // On mobile the Send button sends; plain Enter inserts a newline.
    // Ctrl/Cmd+Enter is kept as a hardware-keyboard shortcut to send.
    const shouldSend = event.ctrlKey || event.metaKey;
    if (!shouldSend) return;
    event.preventDefault();
    void send();
  };

  const toggleSpeech = (): void => {
    if (speech.listening) {
      speech.stop();
      speechCommittedRef.current = '';
      return;
    }
    const speechSessionId = sessionId;
    speechCommittedRef.current = text;
    speech.start((spokenText, isFinal) => {
      if (sessionIdRef.current !== speechSessionId) return;
      const committed = speechCommittedRef.current;
      const next = appendSpeechText(committed, spokenText);
      if (isFinal) speechCommittedRef.current = next;
      applyTextChange(speechSessionId, next);
    });
  };

  const suppressSendAfterStopTap = (): void => {
    suppressSendUntilRef.current = Math.max(suppressSendUntilRef.current, nowMs() + SEND_AFTER_STOP_SUPPRESS_MS);
  };

  const onActionPointerDown = (): void => {
    actionPointerStartedBusyRef.current = busy;
    if (busy) suppressSendAfterStopTap();
  };

  const onActionClick = (): void => {
    if (actionPointerStartedBusyRef.current) {
      actionPointerStartedBusyRef.current = false;
      if (busy) onInterrupt();
      return;
    }
    if (busy) {
      suppressSendAfterStopTap();
      onInterrupt();
      return;
    }
    if (emptyPrompt && !disabled && !attaching) {
      onOpenVoiceMode();
      return;
    }
    void send();
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
  const emptyPrompt = text.trim() === '' && attachments.length === 0;

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
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

      <div className="composer-shell">
        <input
          ref={fileInputRef}
          type="file"
          className="composer-file-input"
          accept={ACCEPTED_IMAGE_TYPES}
          multiple
          onChange={(event) => void onFilesPicked(event)}
          tabIndex={-1}
          aria-hidden="true"
        />
        <input
          ref={cameraInputRef}
          type="file"
          className="composer-file-input"
          accept="image/*"
          capture="environment"
          onChange={(event) => void onFilesPicked(event)}
          tabIndex={-1}
          aria-hidden="true"
        />

        {attachments.length > 0 || attaching ? (
          <div className="composer-attachments" aria-label="Attached images">
            {attachments.map((attachment, index) => (
              <div className="attachment-thumb" key={`${attachment.name}-${index}`}>
                <img src={attachmentSrc(attachment)} alt={attachment.name} />
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={`Remove ${attachment.name}`}
                  title="Remove"
                  onClick={() => removeAttachment(index)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path
                      fill="currentColor"
                      d="M6.4 5l5.6 5.6L17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z"
                    />
                  </svg>
                </button>
              </div>
            ))}
            {attaching ? <div className="attachment-thumb attachment-loading" aria-hidden="true" /> : null}
          </div>
        ) : null}

        {attachError ? <div className="composer-attach-error" role="status">{attachError}</div> : null}
        {speech.error ? <div className="composer-attach-error" role="status">{speech.error}</div> : null}

        <textarea
          ref={areaRef}
          className="composer-input"
          rows={1}
          aria-label="Message your Copilot session"
          disabled={disabled}
          value={text}
          spellCheck={false}
          onKeyDown={onKeyDown}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder={disabled ? disabledPlaceholder : 'Message your Copilot session…'}
        />

        <div className="composer-controls">
          <div className="composer-controls-left">
            <div className="mode-wrap" ref={attachWrapRef}>
              <button
                ref={attachButtonRef}
                type="button"
                className="attach-btn"
                onClick={() => setAttachMenuOpen((v) => !v)}
                disabled={disabled || attaching || attachments.length >= MAX_ATTACHMENTS}
                aria-label="Attach image"
                aria-haspopup="menu"
                aria-expanded={attachMenuOpen}
                title={attachments.length >= MAX_ATTACHMENTS ? `Up to ${MAX_ATTACHMENTS} images` : 'Attach image'}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path fill="currentColor" d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z" />
                </svg>
              </button>
              {attachMenuOpen ? (
                <div className="mode-menu" role="menu" aria-label="Attach image options">
                  <button type="button" role="menuitem" className="mode-menu-item" onClick={openCameraPicker}>
                    <span className="mode-check">📷</span>
                    Take Photo
                  </button>
                  <button type="button" role="menuitem" className="mode-menu-item" onClick={openFilePicker}>
                    <span className="mode-check">🖼️</span>
                    Choose from Library
                  </button>
                </div>
              ) : null}
            </div>
            <div className="mode-wrap" ref={modeWrapRef}>
              <button
                ref={modeButtonRef}
                type="button"
                className="mode-pill"
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
            {folder ? <span className="cwd-chip" title={cwd ?? undefined}>📁 {folder}</span> : null}
          </div>

          <div className="composer-controls-right">
            {speech.supported && !disabled ? (
              <button
                className={`mic-btn${speech.listening ? ' listening' : ''}`}
                type="button"
                onClick={toggleSpeech}
                aria-label={speech.listening ? 'Stop dictation' : 'Start dictation'}
                title={speech.listening ? 'Stop dictation' : 'Start dictation'}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path fill="currentColor" d="M12 14a3 3 0 003-3V6a3 3 0 00-6 0v5a3 3 0 003 3zm5-3a1 1 0 10-2 0 3 3 0 01-6 0 1 1 0 10-2 0 5 5 0 004 4.9V19H8a1 1 0 100 2h8a1 1 0 100-2h-3v-3.1A5 5 0 0017 11z" />
                </svg>
              </button>
            ) : null}
            <button
              className={busy ? 'stop-btn' : `send-btn${emptyPrompt ? ' voice-action' : ''}`}
              type="button"
              onPointerDown={onActionPointerDown}
              onClick={onActionClick}
              disabled={!busy && (disabled || attaching)}
              aria-label={busy ? 'Stop generating' : emptyPrompt ? 'Open Vox' : 'Send'}
              title={busy ? 'Stop generating' : emptyPrompt ? 'Open Vox' : undefined}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                {busy ? (
                  <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
                ) : emptyPrompt ? (
                  <>
                    <rect x="5" y="10" width="2.4" height="4" rx="1.2" fill="currentColor" />
                    <rect x="9" y="6.5" width="2.4" height="11" rx="1.2" fill="currentColor" />
                    <rect x="13" y="4" width="2.4" height="16" rx="1.2" fill="currentColor" />
                    <rect x="17" y="8" width="2.4" height="8" rx="1.2" fill="currentColor" />
                  </>
                ) : (
                  <path fill="currentColor" d="M12 5l6.5 6.5-1.4 1.4L13 8.8V19h-2V8.8l-4.1 4.1-1.4-1.4z" />
                )}
              </svg>
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
