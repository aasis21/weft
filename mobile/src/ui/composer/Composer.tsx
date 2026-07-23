import '@/ui/styles/composer.css';

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, DragEvent, JSX, KeyboardEvent } from 'react';
import { MODES } from '@aasis21/weft-shared';
import type { PromptAttachment, SessionMode } from '@aasis21/weft-shared';
import { PHONE_COMMANDS, getPhoneCommand } from '@aasis21/weft-shared';
import { useSpeechInput } from '@/ui/hooks/useSpeechInput';
import { ACCEPTED_IMAGE_TYPES, attachmentSrc, fileToAttachment } from '@/lib/imageAttachments';
import { isDesktopInput } from '@/lib/platform';

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
  /** Run a whitelisted Copilot CLI slash command on the laptop session (see shared PHONE_COMMANDS). */
  onCommand(name: string, input?: string): void;
  onOpenVoiceMode(): void;
}

/** Max images per message — keeps the encrypted relay payload under the transport cap. */
const MAX_ATTACHMENTS = 6;

/**
 * A slash-menu entry. Two kinds are merged into one menu:
 *  - `command`  — a real Copilot CLI slash command run ON THE LAPTOP via the whitelist
 *                 (session.rpc.commands.invoke). Selecting inserts `/name ` and Enter runs it.
 *  - `template` — prompt sugar with no CLI equivalent; selecting expands to an English instruction
 *                 that is then SENT AS A PROMPT (legacy behavior).
 */
interface SlashItem {
  command: string;
  kind: 'command' | 'template';
  hint: string;
  /** Only for `template` kind: the text inserted into the composer. */
  template?: string;
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

// Real CLI commands (executed on the laptop) come first, built from the shared whitelist so the
// palette and the extension's guard can never drift. Then prompt-template sugar that has no CLI
// equivalent (the colliding /plan and /review are dropped in favor of the real commands).
const COMMAND_ITEMS: SlashItem[] = PHONE_COMMANDS.map((c) => ({
  command: c.label,
  kind: 'command',
  hint: c.confirm ? `${c.hint} · confirms first` : c.hint,
}));

const TEMPLATE_ITEMS: SlashItem[] = [
  { command: '/explain', kind: 'template', hint: 'Explain how something works', template: 'Explain how the following works in detail: ' },
  { command: '/test', kind: 'template', hint: 'Write tests', template: 'Write tests for ' },
  { command: '/fix', kind: 'template', hint: 'Find and fix a bug', template: 'Find and fix the bug in ' },
  { command: '/commit', kind: 'template', hint: 'Stage & commit changes', template: 'Stage all changes and commit with a clear, conventional message.' },
];

const SLASH_ITEMS: SlashItem[] = [...COMMAND_ITEMS, ...TEMPLATE_ITEMS];

const DRAFT_KEY_PREFIX = 'weft.draft.v1.';
const ATTACHMENTS_KEY_PREFIX = 'weft.draft-attachments.v1.';
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
  if (value !== firstToken || !/^\/[a-z-]*$/i.test(firstToken)) return null;
  return firstToken.slice(1).toLowerCase();
}

/**
 * If `value` is a whitelisted CLI command invocation ("/rename My Session"), return its parsed
 * name + trimmed input; otherwise null (so it falls through to being sent as a normal prompt).
 */
function parseCommand(value: string): { name: string; input: string } | null {
  const match = value.match(/^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = (match[1] ?? '').toLowerCase();
  if (!getPhoneCommand(name)) return null;
  return { name, input: (match[2] ?? '').trim() };
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
  onCommand,
  onOpenVoiceMode,
}: ComposerProps): JSX.Element {
  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [pendingCommand, setPendingCommand] = useState<{ name: string; input: string } | null>(null);
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
  const disabledPlaceholder =
    disabledReason === 'offline'
      ? 'Reconnecting… — hold on'
      : 'Session ended — re-pair to continue.';
  const suppressSendUntilRef = useRef(0);
  const speech = useSpeechInput();
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [attachingCount, setAttachingCount] = useState(0);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);
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

  const commandQuery = busy ? null : slashQuery(text);
  const slashOptions = commandQuery === null
    ? []
    : SLASH_ITEMS.filter((item) => item.command.slice(1).startsWith(commandQuery));
  const slashOpen = commandQuery !== null && slashOptions.length > 0 && !slashDismissed;

  useEffect(() => {
    setSlashIndex(0);
  }, [commandQuery]);

  /** Clear the composer after a message/command is dispatched. */
  const clearDraft = (): void => {
    if (speech.listening) speech.stop();
    setText('');
    setAttachments([]);
    setAttachError(null);
    setSlashDismissed(false);
    saveDraft(sessionId, '');
    saveAttachments(sessionId, []);
  };

  const runCommand = (name: string, input: string): void => {
    clearDraft();
    onCommand(name, input || undefined);
  };

  const send = async (): Promise<void> => {
    if (nowMs() < suppressSendUntilRef.current) return;
    const trimmed = text.trim();
    const outgoing = attachments;
    if ((!trimmed && outgoing.length === 0) || disabled || attaching) return;

    // A whitelisted CLI command (with no image attachments) runs on the laptop instead of being
    // sent as a prompt. Unknown "/foo" falls through to onPrompt as literal text (legacy behavior).
    // While Copilot is busy, every submission is steering text for the active turn.
    if (!busy && outgoing.length === 0) {
      const parsed = parseCommand(trimmed);
      if (parsed) {
        const meta = getPhoneCommand(parsed.name);
        if (meta?.arg === 'required' && !parsed.input) return; // wait for the required argument
        if (meta?.confirm) {
          setPendingCommand(parsed);
          return;
        }
        runCommand(parsed.name, parsed.input);
        return;
      }
    }

    clearDraft();
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

  /** Shared by the file picker, camera picker, and Ctrl+V paste — all just hand us a `File[]`. */
  const attachFiles = async (files: File[]): Promise<void> => {
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

  const onFilesPicked = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = event.target;
    const files = Array.from(input.files ?? []);
    input.value = ''; // let the user re-pick the same file after removing it
    await attachFiles(files);
  };

  /** Desktop-only: paste images from the clipboard (Ctrl+V) straight into the composer.
   * Mobile/touch flows (attach button, camera picker) are untouched — this only adds a
   * `paste` listener on the textarea and reuses the same `attachFiles` path. Text paste
   * (no image items) falls through to the browser's default behavior untouched. */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageFiles = items
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!imageFiles.length) return;
    event.preventDefault();
    void attachFiles(imageFiles);
  };

  /** Desktop-only enhancement pairing with Ctrl+V paste: dropping image files onto the
   * composer attaches them via the same `attachFiles` path. Mobile/touch has no drag
   * source for files, so this is inert there — nothing to gate behind isDesktopInput(). */
  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragOver(true);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    dragDepthRef.current = 0;
    setDragOver(false);
    if (!files.length) return;
    event.preventDefault();
    const imageFiles = files.filter((file) => typeof file.type === 'string' && file.type.startsWith('image/'));
    if (!imageFiles.length) return;
    void attachFiles(imageFiles);
  };

  const removeAttachment = (index: number): void => {
    setAttachments((prev) => {
      const updated = prev.filter((_, i) => i !== index);
      saveAttachments(sessionId, updated);
      return updated;
    });
    setAttachError(null);
  };

  const selectSlashCommand = (item: SlashItem): void => {
    if (item.kind === 'command') {
      const meta = getPhoneCommand(item.command.slice(1));
      // No-arg commands are ready to run (Enter sends); arg commands get a trailing space to type into.
      const suffix = meta && meta.arg !== 'none' ? ' ' : '';
      const next = text.replace(/^\/[a-z-]*/i, `${item.command}${suffix}`);
      onTextChange(next);
      setSlashDismissed(true);
      window.requestAnimationFrame(() => areaRef.current?.focus());
      return;
    }
    const next = text.replace(/^\/[a-z-]*/i, item.template ?? '');
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
    // Composing an IME candidate (e.g. Japanese/Chinese input) — Enter confirms the
    // candidate, it must not submit or insert a newline here.
    if (event.nativeEvent.isComposing) return;

    if (isDesktopInput()) {
      // Desktop convention (ChatGPT/Claude/Slack): plain Enter sends; Shift/Ctrl/Cmd+Enter
      // inserts a newline (native textarea behavior, so just let it fall through).
      if (event.shiftKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      void send();
      return;
    }

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

  const onActionClick = (): void => {
    if (nowMs() < suppressSendUntilRef.current) return;
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
              <span className="slash-command">
                {item.command}
                {item.kind === 'command' ? <span className="slash-badge">runs on laptop</span> : null}
              </span>
              <span className="slash-template">{item.kind === 'command' ? item.hint : item.template}</span>
            </button>
          ))}
        </div>
      ) : null}

      {pendingCommand ? (
        <div className="slash-confirm approval-banner" role="alertdialog" aria-label="Confirm command">
          <div className="approval-head approval-warn">
            Run <code>/{pendingCommand.name}</code> on the laptop?
          </div>
          <div className="approval-hint">This command can discard context or change permissions.</div>
          <div className="approval-actions">
            <button type="button" className="reconnect-btn" onClick={() => setPendingCommand(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="bar-menu-item danger"
              onClick={() => {
                const cmd = pendingCommand;
                setPendingCommand(null);
                runCommand(cmd.name, cmd.input);
              }}
            >
              Run /{pendingCommand.name}
            </button>
          </div>
        </div>
      ) : null}

      <div
        className={`composer-shell${dragOver ? ' composer-shell-dragover' : ''}`}
        onDragOver={onDragOver}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {dragOver ? <div className="composer-drop-hint" aria-hidden="true">Drop images to attach</div> : null}
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
          onPaste={onPaste}
          placeholder={
            disabled ? disabledPlaceholder : busy ? 'Steer the current turn…' : 'Message your Copilot session…'
          }
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
            {busy ? (
              <button
                className="stop-btn"
                type="button"
                onPointerDown={suppressSendAfterStopTap}
                onClick={onInterrupt}
                aria-label="Stop generating"
                title="Stop generating"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
                </svg>
              </button>
            ) : null}
            {!busy || !emptyPrompt ? (
              <button
                className={`send-btn${!busy && emptyPrompt ? ' voice-action' : ''}`}
                type="button"
                onClick={onActionClick}
                disabled={disabled || attaching}
                aria-label={busy ? 'Steer current turn' : emptyPrompt ? 'Open Vox' : 'Send'}
                title={busy ? 'Steer current turn' : emptyPrompt ? 'Open Vox' : undefined}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  {!busy && emptyPrompt ? (
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
            ) : null}
          </div>
        </div>
      </div>
    </form>
  );
}
