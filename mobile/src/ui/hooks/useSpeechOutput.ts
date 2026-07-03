import { useCallback, useEffect, useRef, useState } from 'react';

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

export function useSpeechOutput(): {
  supported: boolean;
  speaking: boolean;
  enqueue(text: string): void;
  flush(): void;
  cancel(): void;
} {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const [speaking, setSpeaking] = useState(false);
  const queueRef = useRef<string[]>([]);
  const bufferRef = useRef('');
  const speakingRef = useRef(false);

  const playNext = useCallback((): void => {
    if (!supported) return;
    const text = queueRef.current.shift();
    if (!text) {
      speakingRef.current = false;
      setSpeaking(false);
      return;
    }
    speakingRef.current = true;
    setSpeaking(true);
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.02;
      utterance.pitch = 1;
      utterance.onend = () => playNext();
      utterance.onerror = () => playNext();
      window.speechSynthesis.speak(utterance);
    } catch {
      playNext();
    }
  }, [supported]);

  const enqueueChunk = useCallback((text: string): void => {
    if (!supported) return;
    const clean = text.trim();
    if (!clean) return;
    queueRef.current.push(clean);
    if (!speakingRef.current) playNext();
  }, [playNext, supported]);

  const enqueue = useCallback((text: string): void => {
    if (!supported) return;
    bufferRef.current += text;
    const { sentences, rest } = takeSentences(bufferRef.current);
    bufferRef.current = rest;
    for (const sentence of sentences) enqueueChunk(sentence);
  }, [enqueueChunk, supported]);

  const flush = useCallback((): void => {
    if (!supported) return;
    const rest = bufferRef.current.trim();
    bufferRef.current = '';
    if (rest) enqueueChunk(rest);
  }, [enqueueChunk, supported]);

  const cancel = useCallback((): void => {
    queueRef.current = [];
    bufferRef.current = '';
    speakingRef.current = false;
    setSpeaking(false);
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // speechSynthesis can throw in partially implemented browsers.
    }
  }, []);

  useEffect(() => cancel, [cancel]);

  return { supported, speaking, enqueue, flush, cancel };
}
