import { useEffect, useRef, type JSX } from 'react';
import type { AssistantItem } from '@/lib/timeline';
import { useVoxEngine } from '@/ui/voice/useVoxEngine';

interface VoiceModeOverlayProps {
  latestAssistant: AssistantItem | null;
  agentBusy: boolean;
  toolActive?: boolean;
  disabled: boolean;
  onPrompt(text: string): Promise<void> | void;
  onInterrupt(): void;
  onActiveChange?(active: boolean): void;
  onClose(): void;
}

/**
 * The original full-page Vox surface — a modal that takes over the screen.
 *
 * Still shipped, and now also the "expand" target of the inline VoxDock: the dock is the default
 * entry point, this is the big view you escalate to (and the fallback if the inline one is a bust).
 */
export function VoiceModeOverlay({
  latestAssistant,
  agentBusy,
  toolActive = false,
  disabled,
  onPrompt,
  onInterrupt,
  onActiveChange,
  onClose,
}: VoiceModeOverlayProps): JSX.Element {
  const {
    state,
    caption,
    status,
    orbGlyph,
    replyText,
    showReply,
    handleOrb,
  } = useVoxEngine({
    latestAssistant,
    agentBusy,
    toolActive,
    disabled,
    onPrompt,
    onInterrupt,
    ...(onActiveChange ? { onActiveChange } : {}),
  });
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      if (event.key === ' ' && overlayRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        handleOrb();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // Keep the transcript pinned to the latest (currently-spoken) line as the reply grows, so a long
  // reply reveals what Vox is saying now instead of dumping the whole wall of text.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [latestAssistant?.text, state]);

  return (
    <div className="voice-overlay" role="dialog" aria-modal="true" aria-label="Vox voice mode" ref={overlayRef}>
      <div className="voice-panel" data-state={state}>
        <header className="voice-head">
          <span className="voice-brandmark" aria-hidden="true">
            <span className="voice-brandmark-bar" />
            <span className="voice-brandmark-bar" />
            <span className="voice-brandmark-bar" />
          </span>
          <span className="voice-title">Vox</span>
          <span className="voice-sub">Hands-free conversation in Weft</span>
        </header>

        <button type="button" className="voice-orb" onClick={handleOrb} disabled={disabled && state !== 'speaking'} aria-label={status}>
          <span className="voice-orb-ring" aria-hidden="true" />
          <span className="voice-orb-core" aria-hidden="true">{orbGlyph}</span>
        </button>

        <p className="voice-status" aria-live="polite">{status}</p>

        <div className="voice-body">
          {state === 'listening' ? (
            <p className="voice-caption" aria-live="polite">{caption || 'Listening…'}</p>
          ) : showReply ? (
            <div className="voice-transcript" ref={transcriptRef} aria-live="polite">{replyText}</div>
          ) : (
            <p className="voice-caption" aria-live="polite">{'\u00A0'}</p>
          )}
        </div>

        <div className={`voice-countdown${state === 'listening' && caption.trim() ? ' active' : ''}`} aria-hidden="true">
          <span />
        </div>

        <button ref={closeButtonRef} type="button" className="voice-back-btn" onClick={onClose}>
          Back to chat
        </button>
      </div>
    </div>
  );
}
