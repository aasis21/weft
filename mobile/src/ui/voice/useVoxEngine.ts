import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getVoiceAutoRelisten, getVoiceSpeakStreaming } from '@/lib/settings';
import type { AssistantItem } from '@/lib/timeline';
import { useSpeechInput } from '@/ui/hooks/useSpeechInput';
import { useSpeechOutput } from '@/ui/hooks/useSpeechOutput';

export const SILENCE_MS = 3200;

export type VoiceState = 'idle' | 'ready' | 'listening' | 'thinking' | 'working' | 'speaking';

const LABELS: Record<VoiceState, string> = {
  idle: 'Tap the orb to start',
  ready: 'Tap the orb to talk',
  listening: 'Listening — pause to send',
  thinking: 'Thinking…',
  working: 'Working…',
  speaking: 'Speaking — tap to interrupt',
};

export interface VoxEngineOptions {
  latestAssistant: AssistantItem | null;
  agentBusy: boolean;
  toolActive?: boolean;
  disabled: boolean;
  onPrompt(text: string): Promise<void> | void;
  onInterrupt(): void;
  onActiveChange?(active: boolean): void;
  /** Hold the mic (and any auto-relisten) while something else needs the user — e.g. an approval card. */
  paused?: boolean;
}

export interface VoxEngine {
  state: VoiceState;
  caption: string;
  status: string;
  orbGlyph: string;
  replyText: string;
  showReply: boolean;
  inputSupported: boolean;
  outputSupported: boolean;
  speechError: string | null;
  handleOrb(): void;
  /** Whatever is currently on screen for the user's turn — used to hand the words to the text box. */
  currentTranscript(): string;
}

export function appendSpeechText(committed: string, fresh: string): string {
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

/**
 * The Vox conversation loop — voice in, prompt out, reply spoken, listen again.
 *
 * Extracted from VoiceModeOverlay so the full-page overlay and the inline composer dock are the
 * same machine rendered two ways. Nothing here draws anything; the surfaces own their own JSX.
 */
export function useVoxEngine({
  latestAssistant,
  agentBusy,
  toolActive = false,
  disabled,
  onPrompt,
  onInterrupt,
  onActiveChange,
  paused = false,
}: VoxEngineOptions): VoxEngine {
  const { supported: inputSupported, error: speechError, start: startSpeechInput, stop: stopSpeechInput } = useSpeechInput();
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
  const [speakStreaming, setSpeakStreaming] = useState(false);
  const silenceTimerRef = useRef<number | null>(null);
  const committedRef = useRef('');
  // What the caption is actually showing, interim words included. `committedRef` only advances on a
  // final result, so on its own it silently drops everything the user can see when the silence timer
  // beats the recognizer's final event.
  const heardRef = useRef('');
  const assistantCursorRef = useRef<{ id: string | null; offset: number }>({
    id: latestAssistant?.id ?? null,
    offset: latestAssistant?.text.length ?? 0,
  });
  const sawReplyRef = useRef(false);
  const autoStartedRef = useRef(false);
  const stateRef = useRef<VoiceState>('ready');
  stateRef.current = state;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

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
    // Prefer finalized text, but never send nothing while words are on screen (#voice-transcript-loss).
    const prompt = (committedRef.current.trim() || heardRef.current.trim()).trim();
    committedRef.current = '';
    heardRef.current = '';
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
    if (disabled || pausedRef.current) return;
    cancelSpeech();
    clearSilence();
    committedRef.current = '';
    heardRef.current = '';
    setCaption('');
    setState('listening');
    startSpeechInput((spokenText, isFinal) => {
      const next = appendSpeechText(committedRef.current, spokenText);
      heardRef.current = next;
      setCaption(next || 'Listening…');
      if (isFinal) committedRef.current = next;
      if (next.trim()) armSilence();
    });
  }, [armSilence, cancelSpeech, clearSilence, disabled, startSpeechInput]);

  const handleOrb = useCallback((): void => {
    if (stateRef.current === 'speaking' || outputSpeaking) {
      cancelSpeech();
      onInterrupt();
      startListening();
      return;
    }
    // Interrupt a turn in flight — reasoning ('thinking') OR a running tool ('working'). Previously
    // only 'speaking' could be interrupted, so a tap while the agent worked was silently swallowed
    // by startListening's thinking-guard (#179).
    if (stateRef.current === 'thinking' || stateRef.current === 'working') {
      cancelSpeech();
      onInterrupt();
      startListening();
      return;
    }
    if (stateRef.current === 'listening') {
      sendCaptured();
      return;
    }
    startListening();
  }, [cancelSpeech, onInterrupt, outputSpeaking, sendCaptured, startListening]);

  useEffect(() => {
    onActiveChange?.(true);
    return () => onActiveChange?.(false);
  }, [onActiveChange]);

  useEffect(() => {
    void getVoiceAutoRelisten().then(setAutoRelisten);
    void getVoiceSpeakStreaming().then(setSpeakStreaming);
  }, []);

  // Hands-free entry: begin listening the moment Vox opens (matches Claude/Gemini voice UX) instead
  // of parking on "Tap the orb to talk". Fires once, and only when the mic is usable and no turn is
  // already in flight — if opened mid-turn it holds off until the agent is idle. After the first
  // listen, subsequent turns are governed by the auto-relisten setting (#169).
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (disabled || !inputSupported || agentBusy || paused) return;
    autoStartedRef.current = true;
    startListening();
  }, [disabled, inputSupported, agentBusy, paused, startListening]);

  // Something else needs the user (an approval card) — drop the mic so it doesn't transcribe them
  // reading the dialog, and don't auto-relisten behind it.
  useEffect(() => {
    if (!paused) return;
    clearSilence();
    stopSpeechInput();
    if (stateRef.current === 'listening') setState('ready');
  }, [clearSilence, paused, stopSpeechInput]);

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
    // Full-message mode (streaming off): hold TTS while the agent is still *narrating* (busy, no tool
    // running yet, not finalized) so speech is whole sentences instead of partial deltas. Release —
    // and speak the narration so far — the moment a tool starts (toolActive), the message finalizes
    // (assistant_message → item.final), or the turn goes idle. This is what makes Vox voice "I'll read
    // the file…" BEFORE it flips to Working…, then speak the summary after (#181). Streaming on: speak
    // each delta as it arrives.
    const holdForFullMessage =
      !speakStreaming && latestAssistant.final !== true && agentBusy && !toolActive;
    if (holdForFullMessage) return;
    if (latestAssistant.text.length <= cursor.offset) return;
    const delta = latestAssistant.text.slice(cursor.offset);
    cursor.offset = latestAssistant.text.length;
    if (!delta.trim()) return;
    sawReplyRef.current = true;
    enqueueSpeech(delta);
  }, [agentBusy, enqueueSpeech, latestAssistant, speakStreaming, toolActive]);

  useEffect(() => {
    if (!agentBusy && sawReplyRef.current) flushSpeech();
  }, [agentBusy, flushSpeech]);

  // Speaking + settle. TTS speaking → speaking. When speech stops mid-turn (agent still busy — e.g. a
  // narration block finished before a tool call) fall back to working/thinking so the orb tracks the
  // live turn (#181). When the turn is fully done → ready or auto-relisten.
  useEffect(() => {
    if (outputSpeaking) {
      setState('speaking');
      return;
    }
    if (state === 'speaking') {
      if (agentBusy) {
        setState(toolActive ? 'working' : 'thinking');
      } else {
        sawReplyRef.current = false;
        if (autoRelisten && !paused) startListening();
        else setState('ready');
      }
    }
  }, [agentBusy, autoRelisten, outputSpeaking, paused, startListening, state, toolActive]);

  // Turn ended with nothing (more) to speak — an empty/whitespace-only reply, or speech output is
  // unavailable. Don't leave the orb stuck on Thinking…/Working…; settle to ready or auto-relisten.
  useEffect(() => {
    if (agentBusy || outputSpeaking || sawReplyRef.current) return;
    if (state !== 'thinking' && state !== 'working') return;
    if (autoRelisten && !paused) startListening();
    else setState('ready');
  }, [agentBusy, autoRelisten, outputSpeaking, paused, startListening, state]);

  const status = useMemo(() => {
    if (!inputSupported) return 'Speech recognition unavailable — you can still read replies here.';
    if (!outputSupported && (state === 'speaking' || state === 'thinking' || state === 'working')) return 'Speech output unavailable — showing text only.';
    if (paused) return 'Paused — answer the request above';
    return LABELS[state];
  }, [inputSupported, outputSupported, paused, state]);

  const orbGlyph =
    state === 'listening' ? '●' : state === 'speaking' ? '■' : state === 'working' ? '⚙' : state === 'thinking' ? '⋯' : '🎙';

  const replyText = latestAssistant?.text ?? '';
  const showReply = (state === 'thinking' || state === 'working' || state === 'speaking') && replyText.trim().length > 0;

  const currentTranscript = useCallback((): string => {
    const heard = heardRef.current.trim() || committedRef.current.trim();
    if (heard) return heard;
    return stateRef.current === 'listening' ? '' : caption.trim();
  }, [caption]);

  return {
    state,
    caption,
    status,
    orbGlyph,
    replyText,
    showReply,
    inputSupported,
    outputSupported,
    speechError,
    handleOrb,
    currentTranscript,
  };
}
