import { useEffect, useRef, useState, type CSSProperties, type JSX, type TouchEvent } from 'react';
import type { PromptDelivery } from '@aasis21/weft-shared';
import type { AssistantItem } from '@/lib/timeline';
import { useVoxEngine, type VoiceState } from '@/ui/voice/useVoxEngine';
import { VoxSettings } from '@/ui/voice/VoxSettings';

interface VoxDockProps {
  latestAssistant: AssistantItem | null;
  agentBusy: boolean;
  /** Whether the laptop is on the line. Off the line Vox holds instead of settling. */
  connected?: boolean;
  /** The agent's live one-line note about what it is doing. */
  intent?: string | null;
  toolActive?: boolean;
  disabled: boolean;
  /** Something above the dock needs an answer (approval / ask_user) — hold the mic. */
  paused?: boolean;
  onPrompt(text: string, delivery?: PromptDelivery): Promise<void> | void;
  onInterrupt(): void;
  onActiveChange?(active: boolean): void;
  /** Report the live Vox state so the header pill can mirror the composer (#184). */
  onStateChange?(state: VoiceState): void;
  /** Escalate to the full-page Vox surface. */
  onExpand(): void;
  /** Leave Vox and go back to the keyboard. */
  onKeyboard(): void;
  /** Hand the words we heard back to the text box so a misheard sentence can be fixed. */
  onEditTranscript(text: string): void;
  /** Words carried over from the surface we just came from, so expanding keeps the sentence. */
  initialTranscript?: string;
  /** Hand our in-flight words to whoever mounts next. */
  onTranscriptHandoff?(text: string): void;
  /** Which chat we're pointed at — changing it repoints Vox instead of closing it (#187). */
  conversationKey?: string;
}

/**
 * Vox, inline: the orb sits in the keyboard's slot inside the composer instead of covering the
 * screen. The thread stays visible above it, and approvals/elicitations keep rendering in the dock
 * where they can actually be answered.
 */
export function VoxDock({
  latestAssistant,
  agentBusy,
  connected = true,
  intent = null,
  toolActive = false,
  disabled,
  paused = false,
  onPrompt,
  onInterrupt,
  onActiveChange,
  onStateChange,
  onExpand,
  onKeyboard,
  onEditTranscript,
  initialTranscript = '',
  onTranscriptHandoff,
  conversationKey,
}: VoxDockProps): JSX.Element {
  const {
    state,
    speakingWhileWorking,
    caption,
    status,
    orbGlyph,
    speechError,
    handleOrb,
    currentTranscript,
    autoRelisten,
    silenceMs,
    silenceEpoch,
  } = useVoxEngine({
    latestAssistant,
    agentBusy,
    connected,
    intent,
    toolActive,
    disabled,
    paused,
    onPrompt,
    onInterrupt,
    initialTranscript,
    ...(conversationKey ? { conversationKey } : {}),
    ...(onActiveChange ? { onActiveChange } : {}),
    ...(onStateChange ? { onStateChange } : {}),
    ...(onTranscriptHandoff ? { onTranscriptHandoff } : {}),
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const touchStartYRef = useRef<number | null>(null);
  const heardRef = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Space toggles the orb while focus is inside the dock — same gesture the full-page view uses,
  // minus the modal focus trap (you're still in the chat here).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== ' ') return;
      if (!panelRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      handleOrb();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleOrb]);

  const heard = caption.trim();
  const canEdit = heard.length > 0 && heard !== 'Listening…';
  // Words on screen only while the mic is on. Once the turn is in flight the orb (and the tool cards
  // above it) carry the story — a status line and a stale transcript underneath were just noise.
  const showWords = state !== 'working' && state !== 'speaking';

  // A long sentence used to show its own beginning while the user was still talking. Pin to the
  // bottom so what's on screen is always the last thing said (#186).
  useEffect(() => {
    const el = heardRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [caption, state]);

  const editHeard = (): void => {
    const text = currentTranscript() || heard;
    if (text) onEditTranscript(text);
  };

  // Swipe down on the panel dismisses Vox the way a keyboard dismisses.
  const onTouchStart = (event: TouchEvent<HTMLDivElement>): void => {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  };
  const onTouchEnd = (event: TouchEvent<HTMLDivElement>): void => {
    const start = touchStartYRef.current;
    touchStartYRef.current = null;
    if (start == null) return;
    const end = event.changedTouches[0]?.clientY;
    if (end != null && end - start > 70) onEditTranscript('');
  };

  return (
    <div
      className="vox-dock voice-panel"
      data-state={paused ? 'idle' : state}
      data-working={speakingWhileWorking ? 'true' : undefined}
      data-paused={paused ? 'true' : undefined}
      ref={panelRef}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="vox-dock-head">
        <span className="vox-dock-label">Vox</span>
        <button
          type="button"
          className="vox-head-btn"
          onClick={onKeyboard}
          aria-label="Switch to typing"
          title="Switch to typing"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect
              x="2.5"
              y="6"
              width="19"
              height="12"
              rx="2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              d="M6.5 9.5h.01M10 9.5h.01M13.5 9.5h.01M17 9.5h.01M8 14.5h8"
            />
          </svg>
        </button>
        <button
          type="button"
          className="vox-head-btn"
          onClick={() => setSettingsOpen((open) => !open)}
          aria-label="Vox settings"
          title="Vox settings"
          aria-expanded={settingsOpen}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M19.14 12.94a7.1 7.1 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.67 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.1 7.1 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.12.22.38.3.6.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.48 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.4a3.4 3.4 0 1 1 0-6.8 3.4 3.4 0 0 1 0 6.8Z"
            />
          </svg>
        </button>
        <button
          type="button"
          className="vox-head-btn vox-expand-btn"
          onClick={onExpand}
          aria-label="Expand Vox to full screen"
          title="Expand Vox"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"
            />
          </svg>
        </button>
      </div>

      {settingsOpen ? <VoxSettings autoRelisten={autoRelisten} silenceMs={silenceMs} /> : null}

      <button
        type="button"
        className="voice-orb vox-dock-orb"
        onClick={handleOrb}
        disabled={(disabled || paused) && state !== 'speaking'}
        aria-label={status}
      >
        <span className="voice-orb-ring" aria-hidden="true" />
        <span className="voice-orb-core" aria-hidden="true">{orbGlyph}</span>
        {speakingWhileWorking ? <span className="voice-orb-working" aria-hidden="true" /> : null}
      </button>

      {showWords ? <p className="vox-dock-status" aria-live="polite">{status}</p> : null}

      {showWords ? (
        canEdit ? (
          <button
            type="button"
            className="vox-heard"
            onClick={editHeard}
            title="Edit these words as text"
            ref={heardRef}
          >
            {heard}
          </button>
        ) : (
          <p className="vox-heard vox-heard-empty" aria-live="polite">
            {state === 'listening' ? 'Listening…' : '\u00A0'}
          </p>
        )
      ) : null}

      <div
        className={`voice-countdown${state === 'listening' && canEdit ? ' active' : ''}`}
        aria-hidden="true"
        style={{ '--voice-countdown-duration': `${silenceMs}ms` } as CSSProperties}
      >
        <span key={silenceEpoch} />
      </div>

      {speechError ? <div className="vox-dock-error" role="status">{speechError}</div> : null}
    </div>
  );
}
