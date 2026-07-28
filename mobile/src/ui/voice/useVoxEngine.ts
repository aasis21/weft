import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getVoiceAutoRelisten,
  getVoiceSilenceSeconds,
  getVoiceSpeakStreaming,
  subscribeSettings,
} from '@/lib/settings';
import type { AssistantItem } from '@/lib/timeline';
import { useSpeechInput } from '@/ui/hooks/useSpeechInput';
import { useSpeechOutput } from '@/ui/hooks/useSpeechOutput';

export const SILENCE_MS = 3200;

// One busy state, deliberately. The wire only carries a single `busy` boolean — there is no
// reasoning signal — so "thinking" was only ever an inference from "busy and no tool running".
// Splitting the label invited a distinction the app cannot actually observe (#183).
export type VoiceState = 'idle' | 'ready' | 'listening' | 'working' | 'speaking';

const LABELS: Record<VoiceState, string> = {
  idle: 'Tap the orb to start',
  ready: 'Tap the orb to talk',
  listening: 'Listening — pause to send',
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
  /** Report the live state so the header pill can follow the composer (#184). */
  onStateChange?(state: VoiceState): void;
  /** Hold the mic (and any auto-relisten) while something else needs the user — e.g. an approval card. */
  paused?: boolean;
  /** Words already heard on the surface you just came from — swapping dock↔full-page keeps them. */
  initialTranscript?: string;
  /** Hand the in-flight transcript to whoever unmounts us, so the swap doesn't drop a half sentence. */
  onTranscriptHandoff?(text: string): void;
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
  /** Silence window in ms, from settings — drives the countdown bar's duration. */
  silenceMs: number;
  /** Increments each time the silence window re-arms; use as a React key to replay the countdown. */
  silenceEpoch: number;
  /** Whether the mic reopens on its own after Vox finishes speaking — surfaced in quick settings. */
  autoRelisten: boolean;
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
  onStateChange,
  paused = false,
  initialTranscript = '',
  onTranscriptHandoff,
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
  const [caption, setCaption] = useState(initialTranscript);
  const [autoRelisten, setAutoRelisten] = useState(false);
  const [speakStreaming, setSpeakStreaming] = useState(false);
  const [silenceMs, setSilenceMs] = useState(SILENCE_MS);
  // The silence window is read at fire time, not at arm time — nudging the slider mid-listen must
  // take effect on the very next word rather than the next turn (#186).
  const silenceMsRef = useRef(SILENCE_MS);
  silenceMsRef.current = silenceMs;
  const silenceTimerRef = useRef<number | null>(null);
  // Bumped every time the silence window is (re)armed. Surfaces as a React key so the countdown bar
  // remounts and replays its animation — otherwise it ran once and sat empty for the rest of a long
  // sentence, making it look like nothing was counting (#186).
  const [silenceEpoch, setSilenceEpoch] = useState(0);
  const committedRef = useRef(initialTranscript);
  // What the caption is actually showing, interim words included. `committedRef` only advances on a
  // final result, so on its own it silently drops everything the user can see when the silence timer
  // beats the recognizer's final event.
  const heardRef = useRef(initialTranscript);
  const carriedRef = useRef(initialTranscript);
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
    setState('working');
    void onPrompt(prompt);
  }, [disabled, onPrompt, stopListening]);

  const armSilence = useCallback((): void => {
    clearSilence();
    setSilenceEpoch((n) => n + 1);
    silenceTimerRef.current = window.setTimeout(sendCaptured, silenceMsRef.current);
  }, [clearSilence, sendCaptured]);

  const startListening = useCallback((): void => {
    if (disabled || pausedRef.current) return;
    cancelSpeech();
    clearSilence();
    // Words carried over from the surface we just swapped away from survive exactly one start, so
    // expanding mid-sentence resumes the same sentence instead of starting a new one (#186).
    const seed = carriedRef.current;
    carriedRef.current = '';
    committedRef.current = seed;
    heardRef.current = seed;
    setCaption(seed);
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
    // Interrupt a turn in flight. Previously only 'speaking' could be interrupted, so a tap while
    // the agent worked was silently swallowed by startListening's busy-guard (#179).
    if (stateRef.current === 'working') {
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

  // The header pill mirrors the composer, so it reads "Listening…" / "Speaking…" instead of a flat
  // "Live" while Vox has the floor (#184). Reset on unmount so the pill doesn't keep a stale state.
  const stateChangeRef = useRef(onStateChange);
  stateChangeRef.current = onStateChange;
  useEffect(() => {
    stateChangeRef.current?.(state);
  }, [state]);
  useEffect(() => {
    return () => stateChangeRef.current?.('idle');
  }, []);

  // Swapping surfaces unmounts one engine and mounts the other, and React builds the new tree
  // before tearing down the old — so the words have to be reported continuously, not on unmount,
  // or the surface you expand into would start from a stale sentence (#186).
  const handoffRef = useRef(onTranscriptHandoff);
  handoffRef.current = onTranscriptHandoff;
  useEffect(() => {
    handoffRef.current?.(state === 'listening' ? heardRef.current : '');
  }, [caption, state]);

  useEffect(() => {
    const load = (): void => {
      void getVoiceAutoRelisten().then(setAutoRelisten);
      void getVoiceSpeakStreaming().then(setSpeakStreaming);
      void getVoiceSilenceSeconds().then((s) => setSilenceMs(s * 1000));
    };
    load();
    // Live-follow the quick settings in the dock head so a change applies to this very turn (#186).
    return subscribeSettings((s) => {
      setAutoRelisten(s.voiceAutoRelisten);
      setSpeakStreaming(s.voiceSpeakStreaming);
      setSilenceMs(s.voiceSilenceSeconds * 1000);
    });
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
      setState('working');
    }
  }, [agentBusy, state]);

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
  // narration block finished before a tool call) fall back to working so the orb tracks the live
  // turn (#181). When the turn is fully done → ready or auto-relisten.
  useEffect(() => {
    if (outputSpeaking) {
      setState('speaking');
      return;
    }
    if (state === 'speaking') {
      if (agentBusy) {
        setState('working');
      } else {
        sawReplyRef.current = false;
        if (autoRelisten && !paused) startListening();
        else setState('ready');
      }
    }
  }, [agentBusy, autoRelisten, outputSpeaking, paused, startListening, state]);

  // Turn ended with nothing (more) to speak — an empty/whitespace-only reply, or speech output is
  // unavailable. Don't leave the orb stuck on Working…; settle to ready or auto-relisten.
  useEffect(() => {
    if (agentBusy || outputSpeaking || sawReplyRef.current) return;
    if (state !== 'working') return;
    if (autoRelisten && !paused) startListening();
    else setState('ready');
  }, [agentBusy, autoRelisten, outputSpeaking, paused, startListening, state]);

  const status = useMemo(() => {
    if (!inputSupported) return 'Speech recognition unavailable — you can still read replies here.';
    if (!outputSupported && (state === 'speaking' || state === 'working')) return 'Speech output unavailable — showing text only.';
    if (paused) return 'Paused — answer the request above';
    return LABELS[state];
  }, [inputSupported, outputSupported, paused, state]);

  const orbGlyph =
    state === 'listening' ? '●' : state === 'speaking' ? '■' : state === 'working' ? '⚙' : '🎙';

  const replyText = latestAssistant?.text ?? '';
  const showReply = (state === 'working' || state === 'speaking') && replyText.trim().length > 0;

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
    silenceMs,
    silenceEpoch,
    autoRelisten,
    handleOrb,
    currentTranscript,
  };
}
