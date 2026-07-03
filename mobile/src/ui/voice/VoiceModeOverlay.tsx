import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { getVoiceAutoRelisten } from '@/lib/settings';
import type { AssistantItem } from '@/lib/timeline';
import { useSpeechInput } from '@/ui/hooks/useSpeechInput';
import { useSpeechOutput } from '@/ui/hooks/useSpeechOutput';

const SILENCE_MS = 3200;

type VoiceState = 'idle' | 'ready' | 'listening' | 'thinking' | 'working' | 'speaking';

const LABELS: Record<VoiceState, string> = {
  idle: 'Tap the orb to start',
  ready: 'Tap the orb to talk',
  listening: 'Listening — pause to send',
  thinking: 'Thinking…',
  working: 'Working…',
  speaking: 'Speaking — tap to interrupt',
};

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

function appendSpeechText(committed: string, fresh: string): string {
  const base = committed.trimEnd();
  const tail = fresh.trim();
  if (!tail) return committed;
  if (!base) return tail;
  const a = base.toLowerCase();
  const b = tail.toLowerCase();
  for (let size = Math.min(a.length, b.length); size > 0; size -= 1) {
    if (a.endsWith(b.slice(0, size))) {
      const rest = tail.slice(size).trimStart();
      return rest ? `${base} ${rest}` : base;
    }
  }
  return `${base} ${tail}`;
}

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
  const { supported: inputSupported, start: startSpeechInput, stop: stopSpeechInput } = useSpeechInput();
  const {
    supported: outputSupported,
    speaking: outputSpeaking,
    enqueue: enqueueSpeech,
    flush: flushSpeech,
    cancel: cancelSpeech,
  } = useSpeechOutput();
  const [state, setState] = useState<VoiceState>('ready');
  const [caption, setCaption] = useState('');
  const [autoRelisten, setAutoRelisten] = useState(false);
  const silenceTimerRef = useRef<number | null>(null);
  const committedRef = useRef('');
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const assistantCursorRef = useRef<{ id: string | null; offset: number }>({
    id: latestAssistant?.id ?? null,
    offset: latestAssistant?.text.length ?? 0,
  });
  const sawReplyRef = useRef(false);
  const stateRef = useRef<VoiceState>('ready');
  stateRef.current = state;

  const clearSilence = useCallback((): void => {
    if (silenceTimerRef.current != null) window.clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;
  }, []);

  const stopListening = useCallback((): void => {
    clearSilence();
    stopSpeechInput();
  }, [clearSilence, stopSpeechInput]);

  const sendCaptured = useCallback((): void => {
    if (stateRef.current !== 'listening') return;
    const prompt = committedRef.current.trim();
    committedRef.current = '';
    stopListening();
    if (!prompt || disabled) {
      setCaption('');
      setState('ready');
      return;
    }
    setCaption(prompt);
    setState('thinking');
    void onPrompt(prompt);
  }, [disabled, onPrompt, stopListening]);

  const armSilence = useCallback((): void => {
    clearSilence();
    silenceTimerRef.current = window.setTimeout(sendCaptured, SILENCE_MS);
  }, [clearSilence, sendCaptured]);

  const startListening = useCallback((): void => {
    if (disabled) return;
    cancelSpeech();
    clearSilence();
    committedRef.current = '';
    setCaption('');
    setState('listening');
    startSpeechInput((spokenText, isFinal) => {
      const next = appendSpeechText(committedRef.current, spokenText);
      setCaption(next || 'Listening…');
      if (isFinal) committedRef.current = next;
      if (next.trim()) armSilence();
    });
  }, [armSilence, cancelSpeech, clearSilence, disabled, startSpeechInput]);

  const handleOrb = (): void => {
    if (state === 'speaking' || outputSpeaking) {
      cancelSpeech();
      onInterrupt();
      startListening();
      return;
    }
    // Interrupt a turn in flight — reasoning ('thinking') OR a running tool ('working'). Previously
    // only 'speaking' could be interrupted, so a tap while the agent worked was silently swallowed
    // by startListening's thinking-guard (#179).
    if (state === 'thinking' || state === 'working') {
      cancelSpeech();
      onInterrupt();
      startListening();
      return;
    }
    if (state === 'listening') {
      sendCaptured();
      return;
    }
    startListening();
  };

  useEffect(() => {
    onActiveChange?.(true);
    return () => onActiveChange?.(false);
  }, [onActiveChange]);

  useEffect(() => {
    void getVoiceAutoRelisten().then(setAutoRelisten);
  }, []);

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

  useEffect(() => {
    return () => {
      clearSilence();
      stopSpeechInput();
      cancelSpeech();
    };
  }, [cancelSpeech, clearSilence, stopSpeechInput]);

  useEffect(() => {
    if (agentBusy && state !== 'listening' && state !== 'speaking') {
      setState(toolActive ? 'working' : 'thinking');
    }
  }, [agentBusy, state, toolActive]);

  useEffect(() => {
    if (!latestAssistant) return;
    const cursor = assistantCursorRef.current;
    if (cursor.id !== latestAssistant.id) {
      cursor.id = latestAssistant.id;
      cursor.offset = 0;
      sawReplyRef.current = false;
    }
    if (latestAssistant.text.length <= cursor.offset) return;
    const delta = latestAssistant.text.slice(cursor.offset);
    cursor.offset = latestAssistant.text.length;
    if (!delta.trim()) return;
    sawReplyRef.current = true;
    enqueueSpeech(delta);
  }, [enqueueSpeech, latestAssistant]);

  useEffect(() => {
    if (!agentBusy && sawReplyRef.current) flushSpeech();
  }, [agentBusy, flushSpeech]);

  useEffect(() => {
    if (!outputSupported && (state === 'thinking' || state === 'working') && !agentBusy && sawReplyRef.current) {
      sawReplyRef.current = false;
      if (autoRelisten) startListening();
      else setState('ready');
      return;
    }
    if (outputSpeaking) {
      setState('speaking');
      return;
    }
    if (state === 'speaking' && !agentBusy) {
      sawReplyRef.current = false;
      if (autoRelisten) startListening();
      else setState('ready');
    }
  }, [agentBusy, autoRelisten, outputSpeaking, outputSupported, startListening, state]);

  const status = useMemo(() => {
    if (!inputSupported) return 'Speech recognition unavailable — you can still read replies here.';
    if (!outputSupported && (state === 'speaking' || state === 'thinking' || state === 'working')) return 'Speech output unavailable — showing text only.';
    return LABELS[state];
  }, [inputSupported, outputSupported, state]);

  return (
    <div className="voice-overlay" role="dialog" aria-modal="true" aria-label="Voice mode" ref={overlayRef}>
      <div className="voice-panel" data-state={state}>
        <header className="voice-head">
          <div>
            <span className="voice-title">Voice Mode</span>
            <span className="voice-sub">Hands-free Helm conversation</span>
          </div>
          <button ref={closeButtonRef} type="button" className="icon-btn voice-close" onClick={onClose} aria-label="Close voice mode">
            ✕
          </button>
        </header>

        <button type="button" className="voice-orb" onClick={handleOrb} disabled={disabled && state !== 'speaking'} aria-label={status}>
          <span className="voice-orb-ring" aria-hidden="true" />
          <span className="voice-orb-core" aria-hidden="true">{state === 'listening' ? '●' : state === 'speaking' ? '■' : state === 'working' ? '⚙' : state === 'thinking' ? '⋯' : '🎙'}</span>
        </button>

        <p className="voice-status" aria-live="polite">{status}</p>
        <p className="voice-caption" aria-live="polite">{caption || (state === 'listening' ? 'Listening…' : ' ')}</p>
        <div className={`voice-countdown${state === 'listening' && caption.trim() ? ' active' : ''}`} aria-hidden="true">
          <span />
        </div>
        <p className="voice-hint">Tap the orb to start, send, or interrupt. Escape exits.</p>
      </div>
    </div>
  );
}
