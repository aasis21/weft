import { useCallback, useEffect, useRef, useState } from 'react';
import { createSpeechSanitizer } from '@/ui/voice/speechText';

function findSentenceEnd(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (char === '\n') return index;
    if (char === '.' || char === '!' || char === '?') {
      const next = value.charAt(index + 1);
      if (next === '' || next === ' ' || next === '\n' || next === '"' || next === "'" || next === ')') return index;
    }
  }
  return -1;
}

function takeSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  let guard = 0;
  while (guard < 40) {
    guard += 1;
    const end = findSentenceEnd(rest);
    if (end < 0) break;
    const sentence = rest.slice(0, end + 1).trim();
    if (sentence) sentences.push(sentence);
    rest = rest.slice(end + 1).replace(/^\s+/, '');
  }
  return { sentences, rest };
}

export function splitSpeechSentences(text: string): { sentences: string[]; rest: string } {
  return takeSentences(text);
}

/** How often the watchdog checks whether the engine is still making sound. */
const WATCHDOG_TICK_MS = 1000;
/** How long an utterance may take to start before silence counts as it having been dropped. */
const WATCHDOG_START_GRACE_MS = 5000;

export function useSpeechOutput(): {
  supported: boolean;
  speaking: boolean;
  /** Something is queued, buffered, or mid-utterance — i.e. this reply isn't finished being read. */
  pending: boolean;
  /** The same fact as {@link pending}, read straight from the refs that back it, so it is correct
   *  *within* the commit that queued the text rather than one render later. `pending` is React
   *  state: an effect that enqueues speech and an effect that checks "is anything outstanding?" run
   *  in the same commit, and the checker would see the pre-enqueue value and wrongly conclude the
   *  turn was silent. Anything gating on "may I stop speaking now?" must use this, not `pending`. */
  hasOutstandingSpeech(): boolean;
  enqueue(text: string): void;
  flush(): void;
  cancel(): void;
} {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const [speaking, setSpeaking] = useState(false);
  const [pending, setPending] = useState(false);
  const queueRef = useRef<string[]>([]);
  const bufferRef = useRef('');
  const speakingRef = useRef(false);
  // Bumped by cancel() so an utterance we've already abandoned can't drive the queue from its
  // onend/onerror — cancel() fires those, and the callback would race a freshly started reply.
  const generationRef = useRef(0);
  const watchdogRef = useRef<number | null>(null);
  const sanitizerRef = useRef(createSpeechSanitizer());

  const outstanding = useCallback(
    (): boolean => speakingRef.current || queueRef.current.length > 0 || bufferRef.current.trim().length > 0,
    [],
  );

  const syncPending = useCallback((): void => {
    setPending(outstanding());
  }, [outstanding]);

  const stopWatchdog = useCallback((): void => {
    if (watchdogRef.current != null) window.clearInterval(watchdogRef.current);
    watchdogRef.current = null;
  }, []);

  const playNext = useCallback((): void => {
    if (!supported) return;
    const generation = generationRef.current;
    const text = queueRef.current.shift();
    if (!text) {
      speakingRef.current = false;
      setSpeaking(false);
      stopWatchdog();
      syncPending();
      return;
    }
    speakingRef.current = true;
    setSpeaking(true);
    syncPending();
    const advance = (): void => {
      if (generationRef.current !== generation) return;
      playNext();
    };
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.02;
      utterance.pitch = 1;
      let started = false;
      utterance.onstart = () => {
        started = true;
      };
      utterance.onend = advance;
      utterance.onerror = advance;
      window.speechSynthesis.speak(utterance);
      // Android silently drops an utterance now and then — the engine goes quiet and `onend` never
      // arrives, which used to strand Vox on Working… for the rest of the session. Watch the engine
      // and move on ourselves if it stops reporting speech. Before the utterance has started that
      // needs a long fuse (the engine can take a moment to warm up); after it has started, the
      // moment it goes quiet without telling us is enough.
      const openedAt = Date.now();
      stopWatchdog();
      watchdogRef.current = window.setInterval(() => {
        if (generationRef.current !== generation) {
          stopWatchdog();
          return;
        }
        try {
          if (window.speechSynthesis.speaking || window.speechSynthesis.pending) return;
          if (!started && Date.now() - openedAt < WATCHDOG_START_GRACE_MS) return;
          stopWatchdog();
          advance();
        } catch {
          stopWatchdog();
        }
      }, WATCHDOG_TICK_MS);
    } catch {
      advance();
    }
  }, [stopWatchdog, supported, syncPending]);

  const enqueueChunk = useCallback((text: string): void => {
    if (!supported) return;
    // Sanitise here rather than at the caller: this is the last point before the words become sound,
    // so nothing can reach the engine with markup still in it. It runs per *sentence* (not per
    // streaming delta) because a sentence is a whole line — the sanitiser needs complete lines to
    // recognise a code fence, and a half-line would be rejoined with a spurious space through the
    // middle of a word.
    const clean = sanitizerRef.current.sanitize(text).trim();
    if (!clean) return;
    queueRef.current.push(clean);
    syncPending();
    if (!speakingRef.current) playNext();
  }, [playNext, supported, syncPending]);

  const enqueue = useCallback((text: string): void => {
    if (!supported) return;
    bufferRef.current += text;
    const { sentences, rest } = takeSentences(bufferRef.current);
    bufferRef.current = rest;
    for (const sentence of sentences) enqueueChunk(sentence);
    syncPending();
  }, [enqueueChunk, supported, syncPending]);

  const flush = useCallback((): void => {
    if (!supported) return;
    const rest = bufferRef.current.trim();
    bufferRef.current = '';
    if (rest) enqueueChunk(rest);
    syncPending();
  }, [enqueueChunk, supported, syncPending]);

  const cancel = useCallback((): void => {
    generationRef.current += 1;
    stopWatchdog();
    queueRef.current = [];
    bufferRef.current = '';
    // A cancelled reply may have been abandoned mid-code-block; without this the next reply would
    // start out being swallowed as if it were still inside the fence.
    sanitizerRef.current.reset();
    speakingRef.current = false;
    setSpeaking(false);
    setPending(false);
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // speechSynthesis can throw in partially implemented browsers.
    }
  }, [stopWatchdog]);

  useEffect(() => cancel, [cancel]);

  return { supported, speaking, pending, hasOutstandingSpeech: outstanding, enqueue, flush, cancel };
}
