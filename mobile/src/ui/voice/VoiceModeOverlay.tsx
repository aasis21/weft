import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import type { AssistantItem } from '@/lib/timeline';
import { useVoxEngine, type VoiceState } from '@/ui/voice/useVoxEngine';
import { VoxSettings } from '@/ui/voice/VoxSettings';

interface VoiceModeOverlayProps {
  latestAssistant: AssistantItem | null;
  agentBusy: boolean;
  toolActive?: boolean;
  disabled: boolean;
  onPrompt(text: string): Promise<void> | void;
  onInterrupt(): void;
  onActiveChange?(active: boolean): void;
  /** Report the live Vox state so the header pill can mirror the composer (#184). */
  onStateChange?(state: VoiceState): void;
  /** Shrink back to the inline dock, keeping Vox running. */
  onClose(): void;
  /** Leave Vox entirely and go back to the keyboard. */
  onExit?(): void;
  /** Words carried over from the dock so expanding mid-sentence keeps the sentence. */
  initialTranscript?: string;
  /** Hand our in-flight words back to the dock on collapse. */
  onTranscriptHandoff?(text: string): void;
  /** Which chat we're pointed at — changing it repoints Vox instead of closing it (#187). */
  conversationKey?: string;
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
  onStateChange,
  onClose,
  onExit,
  initialTranscript = '',
  onTranscriptHandoff,
  conversationKey,
}: VoiceModeOverlayProps): JSX.Element {
  const {
    state,
    caption,
    status,
    orbGlyph,
    replyText,
    showReply,
    handleOrb,
    silenceMs,
    silenceEpoch,
    autoRelisten,
  } = useVoxEngine({
    latestAssistant,
    agentBusy,
    toolActive,
    disabled,
    onPrompt,
    onInterrupt,
    initialTranscript,
    ...(conversationKey ? { conversationKey } : {}),
    ...(onActiveChange ? { onActiveChange } : {}),
    ...(onStateChange ? { onStateChange } : {}),
    ...(onTranscriptHandoff ? { onTranscriptHandoff } : {}),
  });
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLParagraphElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  // Same pinning for the user's own words: a long sentence should show its end, not its start.
  useEffect(() => {
    const el = captionRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [caption, state]);

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
          <button
            type="button"
            className="vox-head-btn voice-settings-btn"
            onClick={() => setSettingsOpen((open) => !open)}
            aria-label="Vox settings"
            title="Vox settings"
            aria-expanded={settingsOpen}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="2" />
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"
              />
            </svg>
          </button>
        </header>

        {settingsOpen ? <VoxSettings autoRelisten={autoRelisten} silenceMs={silenceMs} /> : null}

        <button type="button" className="voice-orb" onClick={handleOrb} disabled={disabled && state !== 'speaking'} aria-label={status}>
          <span className="voice-orb-ring" aria-hidden="true" />
          <span className="voice-orb-core" aria-hidden="true">{orbGlyph}</span>
        </button>

        <p className="voice-status" aria-live="polite">{status}</p>

        <div className="voice-body">
          {state === 'listening' ? (
            <p className="voice-caption" aria-live="polite" ref={captionRef}>{caption || 'Listening…'}</p>
          ) : showReply ? (
            <div className="voice-transcript" ref={transcriptRef} aria-live="polite">{replyText}</div>
          ) : (
            <p className="voice-caption" aria-live="polite">{'\u00A0'}</p>
          )}
        </div>

        <div
          className={`voice-countdown${state === 'listening' && caption.trim() ? ' active' : ''}`}
          aria-hidden="true"
          style={{ '--voice-countdown-duration': `${silenceMs}ms` } as CSSProperties}
        >
          <span key={silenceEpoch} />
        </div>

        <div className="voice-foot">
          <button ref={closeButtonRef} type="button" className="voice-back-btn" onClick={onClose}>
            Collapse
          </button>
          {onExit ? (
            <button type="button" className="voice-back-btn voice-exit-btn" onClick={onExit}>
              Back to chat
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
