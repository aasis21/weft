import '@/ui/styles/composer.css';

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, DragEvent, JSX, KeyboardEvent } from 'react';
import type { ModelStateMsg, PhoneCommand, PhoneCommandOption, PromptAttachment, PromptDelivery, SessionMode } from '@aasis21/weft-shared';
import {
  FALLBACK_MODEL_OPTIONS,
  PHONE_COMMANDS,
  SESSION_CONTROL_COMMANDS,
  describeReasoningEffort,
  getPhoneCommand,
  getSessionControlCommand,
  validatePhoneCommandInput,
  withCommandOptions,
} from '@aasis21/weft-shared';
import { useSpeechInput } from '@/ui/hooks/useSpeechInput';
import { VoxDock } from '@/ui/voice/VoxDock';
import type { VoiceState } from '@/ui/voice/useVoxEngine';
import type { AssistantItem } from '@/lib/timeline';
import { ACCEPTED_IMAGE_TYPES, attachmentSrc, fileToAttachment } from '@/lib/imageAttachments';
import { isDesktopInput } from '@/lib/platform';
import { swipeDownToHideKeyboard } from '@/ui/gestures/touchGestures';
import {
  getCommandArgumentStage,
  getCommandArgumentSuggestions,
} from '@/ui/composer/commandPalette';

/** Inline Vox (voice in / voice out) rendered in the composer where the keyboard would be. */
export interface ComposerVox {
  open: boolean;
  latestAssistant: AssistantItem | null;
  toolActive?: boolean;
  /** Whether the laptop is still on the line. Off it, Vox holds rather than settling into a listen. */
  connected?: boolean;
  /** The agent's live one-line note about what it is doing. */
  intent?: string | null;
  thinkingSince?: number | null;
  /** An approval or ask_user prompt is waiting — Vox holds the mic until it's answered. */
  paused?: boolean;
  onOpen(): void;
  onClose(): void;
  /** Escalate to the original full-page Vox surface. */
  onExpand(): void;
  onActiveChange?(active: boolean): void;
  /** Report the live Vox state so the header pill can mirror the composer (#184). */
  onStateChange?(state: VoiceState): void;
  /** Words carried over from the expanded surface so collapsing keeps the sentence (#186). */
  initialTranscript?: string;
  /** Hand the dock's in-flight words to whichever surface mounts next. */
  onTranscriptHandoff?(text: string): void;
  /** Which chat Vox is pointed at — changing it repoints it instead of closing it (#187). */
  conversationKey?: string;
}

interface ComposerProps {
  sessionId: string;
  disabled: boolean;
  disabledReason?: 'ended' | 'offline';
  busy: boolean;
  mode: SessionMode;
  /** Current model and effort, and the models the laptop session can switch to. */
  model?: ModelStateMsg;
  onPrompt(text: string, attachments?: PromptAttachment[], delivery?: PromptDelivery): Promise<void> | void;
  onInterrupt(): void;
  onModeChange(mode: SessionMode): Promise<void> | void;
  /** Switch the model and/or reasoning effort (dropdown, /model, /effort). */
  onModelChange?(change: { modelId?: string; reasoningEffort?: string }): void;
  /** Run a whitelisted Copilot CLI slash command on the laptop session (see shared PHONE_COMMANDS). */
  onCommand(name: string, input?: string): void;
  onOpenVoiceMode(): void;
  /** Omitted → legacy behavior: the waveform button opens the full-page Vox overlay. */
  vox?: ComposerVox;
}

/** Max images per message — keeps the encrypted relay payload under the transport cap. */
const MAX_ATTACHMENTS = 6;

/**
 * A slash-menu entry. Three kinds are merged into one menu:
 *  - `control`  — mode, model or effort, applied by Weft itself (CONTROL.MODE / CONTROL.MODEL_SET).
 *  - `command`  — a real Copilot CLI slash command run ON THE LAPTOP via the whitelist
 *                 (session.rpc.commands.invoke). Selecting inserts `/name ` and Enter runs it.
 *  - `template` — prompt sugar with no CLI equivalent; selecting expands to an English instruction
 *                 that is then SENT AS A PROMPT (legacy behavior).
 */
interface SlashItem {
  command: string;
  kind: 'control' | 'command' | 'template';
  hint: string;
  /** Only for `template` kind: the text inserted into the composer. */
  template?: string;
}

interface ArgumentItem {
  key: string;
  kind: 'argument';
  command: PhoneCommand;
  label: string;
  hint: string;
  input: string;
  disabled?: boolean;
}

type PaletteItem = SlashItem | ArgumentItem;

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

const MODE_COMMANDS = new Set(['interactive', 'plan', 'autopilot']);
const SESSION_MODES: SessionMode[] = ['interactive', 'plan', 'autopilot'];
const MODE_HINT: Record<string, string> = {
  interactive: 'Asks before each action.',
  plan: 'Agrees a plan with you before making changes.',
  autopilot: '⚠ Keeps working without asking you.',
};
const PILL_MODE: Record<string, string> = { plan: 'Plan', autopilot: 'Auto' };
const SHORT_EFFORT: Record<string, string> = { none: 'Off', minimal: 'Min', medium: 'Med', xhigh: 'X-High' };

function shortEffort(value: string): string {
  return SHORT_EFFORT[value] ?? describeReasoningEffort(value);
}

/** The vendor word is redundant in the tight pill ("Claude Opus 5.5" -> "Opus 5.5"). */
function shortModelName(name: string): string {
  return name.replace(/^Claude\s+/i, '');
}

// Real CLI commands (executed on the laptop), built from the shared whitelist so the palette and the
// extension's guard can never drift. Session controls (mode, model, effort) are added per render
// because /model and /effort offer the laptop's live choices. Then prompt-template sugar.
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

const CONTROL_ITEMS: SlashItem[] = SESSION_CONTROL_COMMANDS.map((c) => ({ command: c.label, kind: 'control', hint: c.hint }));

const SLASH_ITEMS: SlashItem[] = [...CONTROL_ITEMS, ...COMMAND_ITEMS, ...TEMPLATE_ITEMS];

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

function commandQuery(value: string): string | null {
  if (!value.startsWith('/')) return null;
  const firstToken = value.split(/\s/, 1)[0] ?? '';
  if (value !== firstToken || !/^\/[a-z-]*$/i.test(firstToken)) return null;
  return firstToken.slice(1).toLowerCase();
}

/**
 * If `value` invokes a known command ("/rename My Session", "/model opus"), return its parsed
 * name + trimmed input; otherwise null (so it falls through to being sent as a normal prompt).
 */
function parseCommand(value: string, findCommand: (name: string) => PhoneCommand | null): { name: string; input: string } | null {
  const match = value.match(/^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = (match[1] ?? '').toLowerCase();
  if (!findCommand(name)) return null;
  return { name, input: (match[2] ?? '').trim() };
}

/** Live model choices for the dropdown and /model; the shared fallback until the laptop reports. */
function modelOptions(model: ModelStateMsg | undefined): PhoneCommandOption[] {
  if (!model?.models.length) return [...FALLBACK_MODEL_OPTIONS];
  return model.models.map((item) => {
    const hint = item.id === model.current?.modelId ? 'Current model'
      : item.efforts.length ? `Effort: ${item.efforts.map(describeReasoningEffort).join(', ')}` : null;
    return { value: item.id, label: item.name, ...(hint ? { hint } : {}) };
  });
}

/** Effort levels the current model supports, as command options. */
function effortOptions(model: ModelStateMsg | undefined): PhoneCommandOption[] {
  const current = model?.models.find((item) => item.id === model.current?.modelId);
  return (current?.efforts ?? []).map((effort) => ({
    value: effort,
    label: describeReasoningEffort(effort),
    ...(effort === model?.current?.reasoningEffort ? { hint: 'Current effort' }
      : effort === current?.defaultEffort ? { hint: 'Model default' } : {}),
  }));
}

export function Composer({
  sessionId,
  disabled,
  disabledReason,
  busy,
  mode,
  model,
  onPrompt,
  onInterrupt,
  onModeChange,
  onModelChange,
  onCommand,
  onOpenVoiceMode,
  vox,
}: ComposerProps): JSX.Element {
  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  /** Choice made in the sheet, shown until the laptop reports the session's new model state. */
  const [picked, setPicked] = useState<{ modelId?: string; effort?: string | null; note?: string } | null>(null);
  useEffect(() => {
    setPicked(null);
  }, [model?.current?.modelId, model?.current?.reasoningEffort]);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [pendingCommand, setPendingCommand] = useState<{ name: string; input: string } | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeSlashRef = useRef<HTMLButtonElement | null>(null);
  const attachWrapRef = useRef<HTMLDivElement | null>(null);
  const attachButtonRef = useRef<HTMLButtonElement | null>(null);
  const modelWrapRef = useRef<HTMLDivElement | null>(null);
  const modelButtonRef = useRef<HTMLButtonElement | null>(null);
  /** Effort section of the sheet; after a model pick we bring it into view so effort is the next step. */
  const effortRef = useRef<HTMLDivElement | null>(null);
  const [effortCue, setEffortCue] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingPickRef = useRef<'library' | 'camera' | null>(null);
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
      if (modelWrapRef.current && !modelWrapRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onDocKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        modelButtonRef.current?.focus();
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

  // /model and /effort offer the laptop's live choices; other commands come from the shared lists.
  const liveModelOptions = modelOptions(model);
  const liveEffortOptions = effortOptions(model);
  const findCommand = (name: string): PhoneCommand | null => {
    const control = getSessionControlCommand(name);
    if (control?.name === 'model') return withCommandOptions(control, liveModelOptions);
    if (control?.name === 'effort') return withCommandOptions(control, liveEffortOptions);
    return control ?? getPhoneCommand(name);
  };

  const parsedDraft = parseCommand(text.trimEnd(), findCommand);
  const argumentStage = busy ? null : getCommandArgumentStage(text, parsedDraft ? findCommand(parsedDraft.name) : null);
  const query = busy ? null : commandQuery(text);
  const commandOptions: PaletteItem[] = query === null
    ? []
    : SLASH_ITEMS.filter((item) => {
        const normalized = query.toLocaleLowerCase();
        return item.command.slice(1).toLocaleLowerCase().includes(normalized)
          || item.hint.toLocaleLowerCase().includes(normalized);
      });
  const argumentOptions: PaletteItem[] = argumentStage
    ? getCommandArgumentSuggestions(argumentStage.command, argumentStage.query).map((item) => ({
        ...item,
        kind: 'argument',
        command: argumentStage.command,
      }))
    : [];
  const slashOptions = argumentStage ? argumentOptions : commandOptions;
  const slashOpen = !busy && slashOptions.length > 0 && !slashDismissed;

  useEffect(() => {
    setSlashIndex(0);
  }, [query, argumentStage?.command.name]);

  useEffect(() => {
    if (!slashOpen) return;
    activeSlashRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [slashIndex, slashOpen]);

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

  /** Switch model, keeping the current effort when the new model supports it, else its default. */
  const chooseModel = (modelId: string): void => {
    const target = model?.models.find((item) => item.id === modelId);
    const currentEffort = model?.current?.reasoningEffort ?? null;
    const kept = !!(target && currentEffort && target.efforts.includes(currentEffort));
    const effort = kept ? currentEffort : target?.defaultEffort ?? null;
    const note = !target?.efforts.length || !effort ? undefined
      : kept ? `Kept ${describeReasoningEffort(effort)}.`
      : `Switched to ${describeReasoningEffort(effort)} (model default).`;
    setPicked({ modelId, effort, ...(note ? { note } : {}) });
    if (target?.efforts.length) {
      setEffortCue(true);
      window.requestAnimationFrame(() => effortRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }));
      window.setTimeout(() => setEffortCue(false), 1400);
    }
    onModelChange?.(effort ? { modelId, reasoningEffort: effort } : { modelId });
  };

  const chooseEffort = (reasoningEffort: string): void => {
    setPicked((prev) => ({ ...(prev?.modelId ? { modelId: prev.modelId } : {}), effort: reasoningEffort }));
    onModelChange?.({ reasoningEffort });
  };

  /** Mode, model and effort are applied by Weft itself, never sent as CLI commands. */
  const applySessionControl = (name: string, input?: string): void => {
    if (MODE_COMMANDS.has(name)) {
      if (name !== mode) void onModeChange(name as SessionMode);
    } else if (name === 'model' && input) {
      if (input !== model?.current?.modelId) chooseModel(input);
    } else if (name === 'effort' && input) {
      chooseEffort(input);
    }
  };

  const runCommand = (name: string, input?: string): void => {
    clearDraft();
    if (getSessionControlCommand(name)) applySessionControl(name, input);
    else onCommand(name, input);
  };

  const submitCommand = (command: PhoneCommand, rawInput: string): boolean => {
    const validated = validatePhoneCommandInput(command, rawInput);
    if (!validated.valid) return false;
    const pending = { name: command.name, input: validated.input ?? '' };
    if (command.confirm) {
      setPendingCommand(pending);
      return true;
    }
    runCommand(pending.name, pending.input || undefined);
    return true;
  };

  const send = async (delivery: PromptDelivery = 'immediate'): Promise<void> => {
    if (nowMs() < suppressSendUntilRef.current) return;
    const trimmed = text.trim();
    const outgoing = attachments;
    if ((!trimmed && outgoing.length === 0) || disabled || attaching) return;

    // A whitelisted CLI command (with no image attachments) runs on the laptop instead of being
    // sent as a prompt. Unknown "/foo" falls through to onPrompt as literal text (legacy behavior).
    // While Copilot is busy, every submission is steering text for the active turn.
    if (!busy && outgoing.length === 0) {
      const parsed = parseCommand(trimmed, findCommand);
      if (parsed) {
        const meta = findCommand(parsed.name);
        if (!meta || !submitCommand(meta, parsed.input)) return;
        return;
      }
    }

    clearDraft();
    const outgoingAttachments = outgoing.length ? outgoing : undefined;
    if (delivery === 'enqueue') {
      await onPrompt(trimmed, outgoingAttachments, delivery);
    } else {
      await onPrompt(trimmed, outgoingAttachments);
    }
  };

  /** One hidden input, retargeted per use. Two inputs were flaky on Android Chrome: the
   *  `capture` one silently swallowed the programmatic click, so "Take photo" did nothing.
   *  Retargeting a single, already-focusable input makes both entries take the same path. */
  const openPicker = (source: 'library' | 'camera'): void => {
    setAttachError(null);
    setAttachMenuOpen(false);
    const input = fileInputRef.current;
    if (!input) return;
    input.value = ''; // re-picking the same file must still fire `change`
    if (source === 'camera') {
      input.setAttribute('accept', 'image/*');
      input.setAttribute('capture', 'environment');
      input.multiple = false;
    } else {
      input.setAttribute('accept', ACCEPTED_IMAGE_TYPES);
      input.removeAttribute('capture');
      input.multiple = true;
    }
    pendingPickRef.current = source;
    input.click();
    if (source === 'camera') {
      // If the camera never opens, the change event never fires and the user sees nothing at
      // all. Give it a generous window, then say so rather than failing silently.
      window.setTimeout(() => {
        if (pendingPickRef.current !== 'camera') return;
        pendingPickRef.current = null;
        setAttachError('No photo came back — if the camera didn’t open, use Photo library instead.');
      }, 45_000);
    }
  };

  const openFilePicker = (): void => openPicker('library');

  const openCameraPicker = (): void => openPicker('camera');

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
    pendingPickRef.current = null;
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

  const selectPaletteItem = (item: PaletteItem): void => {
    if (item.kind === 'argument') {
      if (item.disabled) return;
      submitCommand(item.command, item.input);
      return;
    }
    if (item.kind === 'command' || item.kind === 'control') {
      const meta = findCommand(item.command.slice(1));
      const suffix = meta && meta.input.kind !== 'none' ? ' ' : '';
      const next = text.replace(/^\/[a-z-]*/i, `${item.command}${suffix}`);
      onTextChange(next);
      setSlashDismissed(meta?.input.kind === 'none');
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
        if (item) selectPaletteItem(item);
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

  const voxOpen = vox?.open === true;

  const openVox = (): void => {
    if (vox) {
      if (speech.listening) speech.stop();
      vox.onOpen();
      return;
    }
    onOpenVoiceMode();
  };

  /** Leave Vox for the keyboard, optionally carrying the words Vox heard into the text box. */
  const exitVox = (carryText?: string): void => {
    vox?.onClose();
    if (carryText && carryText.trim()) {
      applyTextChange(sessionId, appendSpeechText(text, carryText));
    }
    window.requestAnimationFrame(() => areaRef.current?.focus());
  };

  const onVoxClick = (): void => {
    if (nowMs() < suppressSendUntilRef.current) return;
    openVox();
  };

  const onActionClick = (): void => {
    if (nowMs() < suppressSendUntilRef.current) return;
    void send();
  };

  const focusMenuItem = (direction: 1 | -1): void => {
    const items = Array.from(modelWrapRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []);
    if (!items.length) return;
    const active = document.activeElement;
    const index = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
    items[(index + direction + items.length) % items.length]?.focus();
  };

  const onModelButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setMenuOpen(true);
    window.requestAnimationFrame(() => focusMenuItem(event.key === 'ArrowDown' ? 1 : -1));
  };

  const onModelMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusMenuItem(event.key === 'ArrowDown' ? 1 : -1);
    }
  };

  const emptyPrompt = text.trim() === '' && attachments.length === 0;
  const selectedModelId = picked?.modelId ?? model?.current?.modelId ?? null;
  const selectedModel = model?.models.find((item) => item.id === selectedModelId);
  const selectedEffort = picked && 'effort' in picked ? picked.effort ?? null : model?.current?.reasoningEffort ?? null;
  const effortNote = picked?.note ?? null;
  const pillLabel = [
    PILL_MODE[mode],
    model?.current ? shortModelName(model.current.name) : 'Model',
    model?.current?.reasoningEffort ? shortEffort(model.current.reasoningEffort) : null,
  ].filter(Boolean).join(' · ');

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {slashOpen ? (
        <div
          className="slash-menu"
          role="listbox"
          aria-label={argumentStage ? `Arguments for /${argumentStage.command.name}` : 'Slash command suggestions'}
        >
          {slashOptions.map((item, index) => (
            <button
              key={item.kind === 'argument' ? item.key : item.command}
              ref={index === slashIndex ? activeSlashRef : undefined}
              type="button"
              role="option"
              aria-selected={index === slashIndex}
              disabled={item.kind === 'argument' && item.disabled}
              className={`slash-item${index === slashIndex ? ' active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectPaletteItem(item)}
            >
              <span className="slash-command">
                {item.kind === 'argument' ? item.label : item.command}
                {item.kind === 'command' ? <span className="slash-badge">runs on laptop</span> : null}
              </span>
              <span className="slash-template">
                {item.kind === 'template' ? item.template : item.hint}
              </span>
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
                runCommand(cmd.name, cmd.input || undefined);
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

        {voxOpen && vox ? (
          <VoxDock
            latestAssistant={vox.latestAssistant}
            agentBusy={busy}
            connected={vox.connected ?? true}
            intent={vox.intent ?? null}
            thinkingSince={vox.thinkingSince ?? null}
            toolActive={vox.toolActive ?? false}
            disabled={disabled}
            paused={vox.paused ?? false}
            onPrompt={(value, delivery) => onPrompt(value, undefined, delivery)}
            onInterrupt={onInterrupt}
            {...(vox.onActiveChange ? { onActiveChange: vox.onActiveChange } : {})}
            {...(vox.onStateChange ? { onStateChange: vox.onStateChange } : {})}
            {...(vox.onTranscriptHandoff ? { onTranscriptHandoff: vox.onTranscriptHandoff } : {})}
            initialTranscript={vox.initialTranscript ?? ''}
            {...(vox.conversationKey ? { conversationKey: vox.conversationKey } : {})}
            onExpand={vox.onExpand}
            onKeyboard={() => exitVox()}
            onEditTranscript={exitVox}
          />
        ) : (
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
            {...swipeDownToHideKeyboard()}
            placeholder={
              disabled ? disabledPlaceholder : busy ? 'Steer the current turn…' : 'Message your Copilot session…'
            }
          />
        )}

        <div className="composer-controls">
          <div className="composer-controls-left">
            {voxOpen ? null : (
              <>
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
                  <path
                    fill="currentColor"
                    d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H5v-2.6l3.6-3.6 3 3 4.4-4.4L19 14.4V19zM8.5 10a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"
                  />
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
            <div className="mode-wrap" ref={modelWrapRef}>
              <button
                ref={modelButtonRef}
                type="button"
                className={`mode-pill model-pill mode-${mode}`}
                aria-haspopup="dialog"
                aria-expanded={menuOpen}
                aria-label={`Session controls: ${pillLabel}`}
                disabled={disabled || !onModelChange}
                onClick={() => setMenuOpen((v) => !v)}
                onKeyDown={onModelButtonKeyDown}
              >
                <span className="pill-dot" aria-hidden="true" />
                <span className="model-pill-name">{pillLabel}</span>
                <span className="pill-caret" aria-hidden="true">▾</span>
              </button>
              {menuOpen ? (
                <>
                  <div className="controls-scrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />
                  <div className="controls-sheet" role="dialog" aria-label="Session controls" onKeyDown={onModelMenuKeyDown}>
                    <span className="controls-handle" aria-hidden="true" />
                    <div className="controls-head">
                      <strong>Session controls</strong>
                      <button type="button" className="controls-done" onClick={() => setMenuOpen(false)}>Done</button>
                    </div>
                    {busy ? <p className="controls-note">Applies from your next message.</p> : null}

                    <div className="controls-label" id="controls-mode">Mode</div>
                    <div className={`controls-seg mode-seg seg-${mode}`} role="radiogroup" aria-labelledby="controls-mode">
                      {SESSION_MODES.map((value) => (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={mode === value}
                          className={mode === value ? 'active' : undefined}
                          onClick={() => { if (value !== mode) void onModeChange(value); }}
                        >
                          {MODE_LABEL[value]}
                        </button>
                      ))}
                    </div>
                    <p className={`controls-hint${mode === 'autopilot' ? ' is-warning' : ''}`}>{MODE_HINT[mode] ?? ''}</p>

                    <div ref={effortRef} className={`controls-effort${effortCue ? ' is-cued' : ''}`}>
                    <div className="controls-label" id="controls-effort">
                      Effort{selectedModel ? <span className="controls-label-model"> · {selectedModel.name}</span> : null}
                    </div>
                    {selectedModel?.efforts.length ? (
                      <>
                        <div className="controls-seg" role="radiogroup" aria-labelledby="controls-effort">
                          {selectedModel.efforts.map((value) => (
                            <button
                              key={value}
                              type="button"
                              role="radio"
                              aria-checked={selectedEffort === value}
                              aria-label={value === selectedModel.defaultEffort
                                ? `${describeReasoningEffort(value)}, model default` : describeReasoningEffort(value)}
                              className={selectedEffort === value ? 'active' : undefined}
                              onClick={() => { if (value !== selectedEffort) chooseEffort(value); }}
                            >
                              {shortEffort(value)}
                              {value === selectedModel.defaultEffort ? <span className="seg-default" aria-hidden="true">•</span> : null}
                            </button>
                          ))}
                        </div>
                        {effortNote ? <p className="controls-hint">{effortNote}</p> : null}
                      </>
                    ) : (
                      <p className="controls-hint">{selectedModel ? 'This model has no effort setting.' : 'Waiting for the laptop’s models…'}</p>
                    )}
                    </div>

                    <div className="controls-label" id="controls-model">Model</div>
                    <div className="controls-models" role="radiogroup" aria-labelledby="controls-model">
                      {liveModelOptions.map((option) => {
                        const selected = option.value === selectedModelId;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className={`controls-model${selected ? ' active' : ''}`}
                            onClick={() => { if (!selected) chooseModel(option.value); }}
                          >
                            <span className="mode-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                            <span className="controls-model-name">{option.label}</span>
                            {option.value === 'auto' ? <span className="controls-model-hint">Recommended</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              ) : null}
            </div>              </>
            )}
          </div>

          <div className="composer-controls-right">
            {speech.supported && !disabled && !voxOpen ? (
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
            {voxOpen ? null : (
              <button
                className="send-btn voice-action"
                type="button"
                onClick={onVoxClick}
                disabled={disabled || attaching}
                aria-label="Open Vox"
                title="Open Vox"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <rect x="5" y="10" width="2.4" height="4" rx="1.2" fill="currentColor" />
                  <rect x="9" y="6.5" width="2.4" height="11" rx="1.2" fill="currentColor" />
                  <rect x="13" y="4" width="2.4" height="16" rx="1.2" fill="currentColor" />
                  <rect x="17" y="8" width="2.4" height="8" rx="1.2" fill="currentColor" />
                </svg>
              </button>
            )}
            {busy && !voxOpen ? (
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
            {busy && !emptyPrompt && !voxOpen ? (
              <button
                className="queue-btn"
                type="button"
                onClick={() => void send('enqueue')}
                disabled={disabled || attaching}
                aria-label="Queue after current turn"
                title="Queue after current turn"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 7h8M5 12h8M17 5v12m-3-3 3 3 3-3"
                  />
                </svg>
              </button>
            ) : null}
            {voxOpen || emptyPrompt ? null : (
              <button
                className="send-btn"
                type="button"
                onClick={onActionClick}
                disabled={disabled || attaching}
                aria-label={busy ? 'Steer current turn' : 'Send'}
                title={busy ? 'Steer current turn' : undefined}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path fill="currentColor" d="M12 5l6.5 6.5-1.4 1.4L13 8.8V19h-2V8.8l-4.1 4.1-1.4-1.4z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
