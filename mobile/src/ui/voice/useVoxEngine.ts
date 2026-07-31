import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PromptDelivery } from '@aasis21/weft-shared';
import {
  getSettings,
  getVoiceAutoRelisten,
  getVoiceSilenceSeconds,
  getVoiceSpeakStreaming,
  subscribeSettings,
} from '@/lib/settings';
import type { AssistantItem } from '@/lib/timeline';
import { useSpeechInput } from '@/ui/hooks/useSpeechInput';
import { useSpeechOutput } from '@/ui/hooks/useSpeechOutput';
import { useAgentStatus } from '@/ui/useAgentStatus';

export const SILENCE_MS = 3200;

/** How long a sent prompt may wait for the laptop to report the turn before we stop holding the
 *  orb on Working…. Generous: a queued or steering prompt can sit a while before it runs. */
const TURN_START_GRACE_MS = 12_000;

/** How long "the turn is over and nothing is outstanding" must hold before Vox actually settles out
 *  of Working…. A turn can go idle a beat BEFORE its last text lands, so settling on the first quiet
 *  observation reopens the mic and cancels the reply that was about to be spoken. Re-checked from
 *  refs when it fires, and torn down the moment anything starts speaking again (#196). */
const SETTLE_QUIET_MS = 400;

// One busy state, deliberately. The wire only carries a single `busy` boolean — there is no
// reasoning signal — so "thinking" was only ever an inference from "busy and no tool running".
// Splitting the label invited a distinction the app cannot actually observe (#183).
export type VoiceState = 'idle' | 'ready' | 'listening' | 'working' | 'speaking' | 'offline';

const LABELS: Record<VoiceState, string> = {
  idle: 'Tap the orb to start',
  ready: 'Tap the orb to talk',
  listening: 'Listening — pause to send',
  working: 'Working…',
  speaking: 'Speaking — tap to interrupt',
  offline: 'Reconnecting to your laptop…',
};

export interface VoxEngineOptions {
  latestAssistant: AssistantItem | null;
  agentBusy: boolean;
  /**
   * Whether the laptop is actually on the line. Distinct from `agentBusy`, and the distinction is
   * the whole point: `agentBusy` is false both when the agent has finished AND when we simply
   * cannot see it. Vox used to read the second as the first, settle, and reopen the mic over a turn
   * that was still running — then refuse to leave `listening` when the connection came back.
   */
  connected?: boolean;
  /** The agent's live one-line note about what it is doing, shown in place of "Working…". */
  intent?: string | null;
  /** Local-clock start of the agent's current thinking block, shown as a live "Thinking… Ns". */
  thinkingSince?: number | null;
  toolActive?: boolean;
  disabled: boolean;
  onPrompt(text: string, delivery?: PromptDelivery): Promise<void> | void;
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
  /**
   * Which conversation we're pointed at. Vox stays on when you switch chats (#187) — changing this
   * repoints the mic at the new session, drops the old session's half-sentence, and refuses to read
   * out the reply that was already sitting there.
   */
  conversationKey?: string;
}

export interface VoxEngine {
  state: VoiceState;
  /** Vox has the floor while the laptop is still on its turn — the two overlap by design now. */
  speakingWhileWorking: boolean;
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
  connected = true,
  intent = null,
  thinkingSince = null,
  toolActive = false,
  disabled,
  onPrompt,
  onInterrupt,
  onActiveChange,
  onStateChange,
  paused = false,
  initialTranscript = '',
  onTranscriptHandoff,
  conversationKey,
}: VoxEngineOptions): VoxEngine {
  const { supported: inputSupported, error: speechError, start: startSpeechInput, stop: stopSpeechInput } = useSpeechInput();
  const {
    supported: outputSupported,
    speaking: outputSpeaking,
    pending: speechPending,
    hasOutstandingSpeech,
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
  // Read when a listening session opens, so it can't change the mode of a session already running.
  const continuousRef = useRef(false);
  const silenceTimerRef = useRef<number | null>(null);
  // A prompt has been sent but the laptop hasn't reported the turn yet. Held so the settle effect
  // doesn't mistake "hasn't started" for "already finished".
  const awaitingTurnRef = useRef(false);
  const awaitingTurnTimerRef = useRef<number | null>(null);
  const [settleEpoch, setSettleEpoch] = useState(0);
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
  // Whether we currently intend to hold the mic. Tracks intent rather than rendered state so the
  // safety net below can tell "not listening yet" from "no longer listening".
  const micWantedRef = useRef(false);
  /** Text carried in from another surface — the recognizer's transcript is appended to this, not to
   *  itself, since each callback already carries everything heard this listen. */
  const seedRef = useRef('');
  const stateRef = useRef<VoiceState>('ready');
  stateRef.current = state;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  const clearSilence = useCallback((): void => {
    if (silenceTimerRef.current != null) window.clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;
  }, []);

  const stopListening = useCallback((): void => {
    micWantedRef.current = false;
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
    // The turn hasn't reached the laptop yet, so `agentBusy` is still false. Without this the
    // settle effect sees "working, not busy, nothing to speak" and bounces straight back out —
    // reopening the mic just in time to talk over the reply it was waiting for.
    awaitingTurnRef.current = true;
    if (awaitingTurnTimerRef.current != null) window.clearTimeout(awaitingTurnTimerRef.current);
    awaitingTurnTimerRef.current = window.setTimeout(() => {
      awaitingTurnRef.current = false;
      // Nudge the settle effect: if the turn never started, don't sit on Working… forever.
      setSettleEpoch((n) => n + 1);
    }, TURN_START_GRACE_MS);
    void onPrompt(prompt);
  }, [disabled, onPrompt, stopListening]);

  const armSilence = useCallback((): void => {
    clearSilence();
    setSilenceEpoch((n) => n + 1);
    silenceTimerRef.current = window.setTimeout(sendCaptured, silenceMsRef.current);
  }, [clearSilence, sendCaptured]);

  const startListening = useCallback((): void => {
    if (disabled || pausedRef.current || !connectedRef.current) return;
    cancelSpeech();
    clearSilence();
    // Words carried over from the surface we just swapped away from survive exactly one start, so
    // expanding mid-sentence resumes the same sentence instead of starting a new one (#186).
    const seed = carriedRef.current;
    carriedRef.current = '';
    seedRef.current = seed;
    committedRef.current = seed;
    heardRef.current = seed;
    setCaption(seed);
    setState('listening');
    micWantedRef.current = true;
    startSpeechInput((spokenText, isFinal) => {
      // What arrives is the whole run, not the newest fragment — so this replaces rather than
      // accumulates. Appending it turned "hey man" into "hey heyman" and grew from there (#192).
      const next = appendSpeechText(seedRef.current, spokenText);
      heardRef.current = next;
      setCaption(next || 'Listening…');
      if (isFinal) committedRef.current = next;
      if (next.trim()) armSilence();
    }, { continuous: continuousRef.current });
  }, [armSilence, cancelSpeech, clearSilence, disabled, startSpeechInput]);

  const handleOrb = useCallback((): void => {
    // Off the line the orb does nothing but stop the voice. Opening the mic would collect a prompt
    // with nowhere to go, and cutting the turn would fire a decision into a dead socket.
    if (!connectedRef.current) {
      if (outputSpeaking) cancelSpeech();
      return;
    }
    if (stateRef.current === 'speaking' || outputSpeaking) {
      cancelSpeech();
      // Only cut the turn short when there is no turn left to protect. Speech routinely outlives the
      // work that produced it now, so a tap here usually means "stop talking", not "throw away what
      // you are doing" — and killing a running turn is not something a silence gesture should do.
      if (!agentBusy) onInterrupt();
      startListening();
      return;
    }
    // Talking over a running turn steers it. The mic opens without cancelling anything, the agent
    // keeps working while you speak, and the prompt goes out as a normal immediate send -- which
    // the SDK applies to the turn already in flight. Queueing is left to the composer's explicit
    // queue button, because "wait until you're done" is a deliberate choice, not what a mid-turn
    // interjection means. Before #179 this tap was swallowed by startListening's busy-guard.
    if (stateRef.current === 'working') {
      startListening();
      return;
    }
    if (stateRef.current === 'listening') {
      sendCaptured();
      return;
    }
    startListening();
  }, [agentBusy, cancelSpeech, onInterrupt, outputSpeaking, sendCaptured, startListening]);

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
      void getSettings().then((s) => {
        continuousRef.current = s.voiceContinuous;
      });
    };
    load();
    // Live-follow the quick settings in the dock head so a change applies to this very turn (#186).
    return subscribeSettings((s) => {
      setAutoRelisten(s.voiceAutoRelisten);
      setSpeakStreaming(s.voiceSpeakStreaming);
      setSilenceMs(s.voiceSilenceSeconds * 1000);
      // Takes effect on the next listening session — the open one keeps the mode it started with.
      continuousRef.current = s.voiceContinuous;
    });
  }, []);

  // Hands-free entry: begin listening the moment Vox opens (matches Claude/Gemini voice UX) instead
  // of parking on "Tap the orb to talk". Fires once, and only when the mic is usable and no turn is
  // already in flight — if opened mid-turn it holds off until the agent is idle. After the first
  // listen, subsequent turns are governed by the auto-relisten setting (#169).
  //
  // "Idle" has to include the speech queue, not just the agent. Opening mid-turn parks this effect
  // until agentBusy clears, which is the same instant the turn's closing reply is handed to TTS —
  // and startListening() opens by cancelling speech, so firing here would swallow that reply
  // outright (#196). Waiting for the queue to drain costs nothing; the effect re-runs when it does.
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (disabled || !inputSupported || agentBusy || paused || !connected) return;
    if (hasOutstandingSpeech()) return;
    autoStartedRef.current = true;
    startListening();
  }, [disabled, inputSupported, agentBusy, connected, hasOutstandingSpeech, outputSpeaking, paused, speechPending, startListening]);

  // The line to the laptop went down. Anything said now would be transcribed into a void — the
  // prompt cannot be delivered and the reply cannot arrive — so drop the mic and say so. This is
  // also what stops the settle path from mistaking "cannot see the agent" for "agent finished".
  useEffect(() => {
    if (connected) return;
    clearSilence();
    micWantedRef.current = false;
    stopSpeechInput();
    if (stateRef.current !== 'speaking') setState('offline');
  }, [clearSilence, connected, stopSpeechInput]);

  // Back on the line. Rejoin whatever is actually true over there rather than resuming from a stale
  // idea of it: if a turn is still running we go back to watching it, otherwise we settle normally
  // (which honours auto-relisten). This doubles as the recovery net for any path that leaves Vox
  // listening across a drop — coming back busy always wins over a mic we opened while blind.
  const wasConnectedRef = useRef(connected);
  useEffect(() => {
    const wasConnected = wasConnectedRef.current;
    wasConnectedRef.current = connected;
    if (!connected || wasConnected) return;
    if (agentBusy) {
      clearSilence();
      micWantedRef.current = false;
      stopSpeechInput();
      setState('working');
      return;
    }
    if (stateRef.current === 'offline') setState('ready');
  }, [agentBusy, clearSilence, connected, stopSpeechInput]);

  // Something else needs the user (an approval card) — drop the mic so it doesn't transcribe them
  // reading the dialog, and don't auto-relisten behind it.
  useEffect(() => {
    if (!paused) return;
    clearSilence();
    micWantedRef.current = false;
    stopSpeechInput();
    if (stateRef.current === 'listening') setState('ready');
  }, [clearSilence, paused, stopSpeechInput]);

  useEffect(() => {
    return () => {
      clearSilence();
      if (awaitingTurnTimerRef.current != null) window.clearTimeout(awaitingTurnTimerRef.current);
      micWantedRef.current = false;
      stopSpeechInput();
      cancelSpeech();
    };
  }, [cancelSpeech, clearSilence, stopSpeechInput]);

  useEffect(() => {
    if (agentBusy && state !== 'listening' && state !== 'speaking') {
      setState('working');
    }
  }, [agentBusy, state]);
  // The turn we were waiting for has started (or the chat went busy for any reason) — release the
  // grace period so the settle effect can do its job normally again.
  useEffect(() => {
    if (!agentBusy) return;
    awaitingTurnRef.current = false;
    if (awaitingTurnTimerRef.current != null) window.clearTimeout(awaitingTurnTimerRef.current);
    awaitingTurnTimerRef.current = null;
  }, [agentBusy]);

  // The one invariant worth enforcing structurally: the mic is open only while we mean to listen.
  // Every path out of listening already drops it, but "already" is doing a lot of work there —
  // one missed call site and the phone quietly transcribes the room while Vox is talking (#189).
  //
  // The check is against intent, not the rendered state: `state` here is a snapshot from the render
  // this effect belongs to, so an effect that started the mic earlier in the same commit hasn't
  // shown up in it yet — trusting it would close the mic the instant Vox opened.
  useEffect(() => {
    if (state === 'listening' || micWantedRef.current) return;
    stopSpeechInput();
  }, [state, stopSpeechInput]);

  // Switching chats with Vox on: stop mid-sentence, forget the words meant for the old chat, and
  // don't barge into a turn that's already running there (#188). If the new chat is busy we stand
  // by silently — mic off, nothing spoken — and pick up from whatever the agent says next.
  const skipUntilIdleRef = useRef(false);
  const skipCurrentReplyRef = useRef(false);
  const startRef = useRef(startListening);
  startRef.current = startListening;
  const busyRef = useRef(agentBusy);
  busyRef.current = agentBusy;
  const autoRelistenRef = useRef(autoRelisten);
  autoRelistenRef.current = autoRelisten;
  // Armed by the settle effect, fired only if the quiet has held. Cleared by anything that resumes
  // speaking or by leaving 'working', so a late trailing sentence always wins over the settle.
  const settleTimerRef = useRef<number | null>(null);
  const clearSettleTimer = useCallback((): void => {
    if (settleTimerRef.current != null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
  }, []);
  /** Leave Working… — reopen the mic if auto-relisten is on, otherwise go quiet. */
  const settleOut = useCallback((): void => {
    sawReplyRef.current = false;
    if (autoRelistenRef.current && !pausedRef.current) startRef.current();
    else setState('ready');
  }, []);
  const firstConversationRef = useRef(true);
  useEffect(() => {
    if (firstConversationRef.current) {
      firstConversationRef.current = false;
      return;
    }
    clearSilence();
    cancelSpeech();
    stopListening();
    sawReplyRef.current = false;
    committedRef.current = '';
    heardRef.current = '';
    carriedRef.current = '';
    setCaption('');
    // Whatever reply is already sitting in that chat is old news either way.
    skipCurrentReplyRef.current = true;
    if (busyRef.current) {
      // Mid-turn over there. Don't take the mic (we'd transcribe over its answer) and don't read out
      // a reply that's half-written — wait for it to finish, then behave normally.
      skipUntilIdleRef.current = true;
      setState('working');
      return;
    }
    setState('ready');
    startRef.current();
  }, [cancelSpeech, clearSilence, conversationKey, stopListening]);

  // The turn we walked in on has finished — swallow it whole (it wasn't ours to narrate) and be a
  // full participant from the next one onward.
  useEffect(() => {
    if (agentBusy || !skipUntilIdleRef.current) return;
    skipUntilIdleRef.current = false;
    const cursor = assistantCursorRef.current;
    if (latestAssistant) {
      cursor.id = latestAssistant.id;
      cursor.offset = latestAssistant.text.length;
    }
    sawReplyRef.current = false;
    skipCurrentReplyRef.current = false;
  }, [agentBusy, latestAssistant]);

  useEffect(() => {
    if (!latestAssistant) return;
    // Standing by on a turn that was already running when we arrived — say nothing until it lands.
    if (skipUntilIdleRef.current && agentBusy) return;
    const cursor = assistantCursorRef.current;
    if (cursor.id !== latestAssistant.id) {
      cursor.id = latestAssistant.id;
      // Right after a chat switch the "new" message is old news — start at its end so Vox picks up
      // from whatever the agent says next instead of reciting the backlog (#187).
      cursor.offset = skipCurrentReplyRef.current ? latestAssistant.text.length : 0;
      skipCurrentReplyRef.current = false;
      sawReplyRef.current = false;
    } else if (skipCurrentReplyRef.current) {
      // Same message still growing — skip everything written so far, speak only what comes next.
      cursor.offset = latestAssistant.text.length;
      skipCurrentReplyRef.current = false;
      sawReplyRef.current = false;
    }
    // Hand text over the moment it lands, tool call or not. The speech queue is the thing that
    // decides what is *speakable*: `enqueue` splits on sentence boundaries and keeps any trailing
    // fragment buffered, so releasing early can never produce half a sentence -- which means
    // waiting for the segment to finish was pure delay. And delay is expensive here, because
    // speaking takes real time: while the queue drains the agent has already written the next few
    // lines and started another tool, so anything held just accumulates as silence with a backlog
    // behind it. Vox therefore keeps talking straight through tool calls (#181).
    if (latestAssistant.text.length <= cursor.offset) return;
    const delta = latestAssistant.text.slice(cursor.offset);
    cursor.offset = latestAssistant.text.length;
    if (!delta.trim()) return;
    sawReplyRef.current = true;
    enqueueSpeech(delta);
    // Streaming on: don't even wait for the sentence to close — say the words as they generate.
    if (speakStreaming) flushSpeech();
  }, [enqueueSpeech, flushSpeech, latestAssistant, speakStreaming]);

  // Speak whatever is left in the buffer once the turn is over. This has to watch the reply as well
  // as the busy flag: a turn can go idle before its last text lands, and keying only on `agentBusy`
  // meant that effect never re-ran — so a reply that arrived after idle, or one that simply ended
  // without sentence punctuation, sat in the buffer and was never spoken at all.
  useEffect(() => {
    if (!agentBusy && sawReplyRef.current) flushSpeech();
  }, [agentBusy, flushSpeech, latestAssistant]);

  // Speaking + settle. TTS speaking → speaking. When speech stops, always fall back to `working` and
  // let the quiet-grace settle effect below decide whether the turn is genuinely over. Routing both
  // exits through one grace window is what stops a trailing sentence — one that lands just after the
  // turn goes idle — from being talked over by a freshly reopened mic (#196).
  useEffect(() => {
    if (outputSpeaking) {
      clearSettleTimer();
      setState('speaking');
      return;
    }
    if (state === 'speaking') setState('working');
  }, [clearSettleTimer, outputSpeaking, state]);

  // Turn ended with nothing (more) to speak — an empty/whitespace-only reply, speech output is
  // unavailable, or the engine took the text and never made a sound. Don't leave the orb stuck on
  // Working…; settle to ready or auto-relisten.
  //
  // The gate is "is there speech still outstanding", not "did we ever speak this turn". The old
  // flag was set the moment text was handed to TTS and only cleared on the way out of `speaking`,
  // so if the utterance never actually started there was no way back — Vox sat on Working… for
  // the rest of the session and the mic never reopened.
  //
  // Two things make that gate trustworthy (#196). It reads `hasOutstandingSpeech()` — straight from
  // the speech engine's refs — rather than the `pending` STATE, which is a render behind: the effect
  // that enqueues the final sentence and this one run in the SAME commit, so the state copy still
  // says "nothing queued" and we would settle, and startListening() opens by cancelling speech —
  // silently destroying the reply we had just queued. And it waits SETTLE_QUIET_MS before acting,
  // because a turn can go idle a beat before its last text arrives; the timer re-checks from refs
  // and is torn down by anything that starts speaking again.
  useEffect(() => {
    // `connected` is load-bearing here, not defensive: off the line, `agentBusy` reads false because
    // we cannot see the agent, not because it stopped. Settling on that is what reopened the mic
    // over a running turn (#198).
    const quiet =
      connected && !agentBusy && !outputSpeaking && !hasOutstandingSpeech() && !awaitingTurnRef.current;
    if (!quiet || state !== 'working') {
      clearSettleTimer();
      return;
    }
    if (settleTimerRef.current != null) return;
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      if (busyRef.current || awaitingTurnRef.current) return;
      if (!connectedRef.current) return;
      if (hasOutstandingSpeech()) return;
      if (stateRef.current !== 'working') return;
      settleOut();
    }, SETTLE_QUIET_MS);
  }, [agentBusy, clearSettleTimer, connected, hasOutstandingSpeech, outputSpeaking, settleEpoch, settleOut, speechPending, state]);

  useEffect(() => clearSettleTimer, [clearSettleTimer]);

  const workingLabel = useAgentStatus(intent, thinkingSince, LABELS.working);

  const status = useMemo(() => {
    if (!inputSupported) return 'Speech recognition unavailable — you can still read replies here.';
    if (!outputSupported && (state === 'speaking' || state === 'working')) return 'Speech output unavailable — showing text only.';
    // Ahead of `paused`: off the line nothing can be sent or answered, so that is the more useful
    // thing to say even if an approval happens to be on screen.
    if (!connected) return LABELS.offline;
    if (paused) return 'Paused — answer the request above';
    // Speaking and working are two different machines: the phone's voice and the laptop's turn. They
    // now overlap as a matter of course, so the label says both rather than letting the voice hide
    // the fact that work is still running.
    if (state === 'speaking' && agentBusy) return 'Speaking — agent still working';
    // When the agent has told us what it is doing — or is visibly thinking — say that instead of
    // the generic "Working…".
    if (state === 'working') return workingLabel;
    return LABELS[state];
  }, [agentBusy, connected, inputSupported, outputSupported, paused, state, workingLabel]);

  // Working deliberately has no glyph. It used to be a gear, which is the same shape as the settings
  // gear in the toolbar a few pixels above the orb — two unrelated things drawn identically on one
  // screen. The state is carried by the ring instead, which spins into a travelling arc and cannot
  // be confused with a button.
  const orbGlyph =
    state === 'listening'
      ? '●'
      : state === 'speaking'
        ? '■'
        : state === 'working'
          ? ''
          : state === 'offline'
            ? '⚡'
            : '🎙';

  /** Vox has the floor while the laptop is still on its turn. Surfaced so the dock and the overlay
   *  can keep the working indicator up underneath the speaking orb, instead of the two states
   *  taking turns and flickering as each segment drains. */
  const speakingWhileWorking = state === 'speaking' && agentBusy;

  const replyText = latestAssistant?.text ?? '';
  const showReply = (state === 'working' || state === 'speaking') && replyText.trim().length > 0;

  const currentTranscript = useCallback((): string => {
    const heard = heardRef.current.trim() || committedRef.current.trim();
    if (heard) return heard;
    return stateRef.current === 'listening' ? '' : caption.trim();
  }, [caption]);

  return {
    state,
    speakingWhileWorking,
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
