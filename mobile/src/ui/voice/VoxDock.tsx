import { useEffect, useRef, type JSX, type TouchEvent } from 'react';
import type { AssistantItem } from '@/lib/timeline';
import { useVoxEngine } from '@/ui/voice/useVoxEngine';

interface VoxDockProps {
  latestAssistant: AssistantItem | null;
  agentBusy: boolean;
  toolActive?: boolean;
  disabled: boolean;
  /** Something above the dock needs an answer (approval / ask_user) — hold the mic. */
  paused?: boolean;
  onPrompt(text: string): Promise<void> | void;
  onInterrupt(): void;
  onActiveChange?(active: boolean): void;
  /** Escalate to the full-page Vox surface. */
  onExpand(): void;
  /** Leave Vox and go back to the keyboard. */
  onKeyboard(): void;
  /** Hand the words we heard back to the text box so a misheard sentence can be fixed. */
  onEditTranscript(text: string): void;
}

/**
 * Vox, inline: the orb sits in the keyboard's slot inside the composer instead of covering the
 * screen. The thread stays visible above it, and approvals/elicitations keep rendering in the dock
 * where they can actually be answered.
 */
export function VoxDock({
  latestAssistant,
  agentBusy,
  toolActive = false,
  disabled,
  paused = false,
  onPrompt,
  onInterrupt,
  onActiveChange,
  onExpand,
  onKeyboard,
  onEditTranscript,
}: VoxDockProps): JSX.Element {
  const {
    state,
    caption,
    status,
    orbGlyph,
    speechError,
    handleOrb,
    currentTranscript,
  } = useVoxEngine({
    latestAssistant,
    agentBusy,
    toolActive,
    disabled,
    paused,
    onPrompt,
    onInterrupt,
    ...(onActiveChange ? { onActiveChange } : {}),
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const touchStartYRef = useRef<number | null>(null);

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

      <button
        type="button"
        className="voice-orb vox-dock-orb"
        onClick={handleOrb}
        disabled={(disabled || paused) && state !== 'speaking'}
        aria-label={status}
      >
        <span className="voice-orb-ring" aria-hidden="true" />
        <span className="voice-orb-core" aria-hidden="true">{orbGlyph}</span>
      </button>

      {showWords ? <p className="vox-dock-status" aria-live="polite">{status}</p> : null}

      {showWords ? (
        canEdit ? (
          <button type="button" className="vox-heard" onClick={editHeard} title="Edit these words as text">
            {heard}
          </button>
        ) : (
          <p className="vox-heard vox-heard-empty" aria-live="polite">
            {state === 'listening' ? 'Listening…' : '\u00A0'}
          </p>
        )
      ) : null}

      <div className={`voice-countdown${state === 'listening' && canEdit ? ' active' : ''}`} aria-hidden="true">
        <span />
      </div>

      {speechError ? <div className="vox-dock-error" role="status">{speechError}</div> : null}
    </div>
  );
}
