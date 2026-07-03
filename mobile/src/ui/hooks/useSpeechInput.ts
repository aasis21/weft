import { useCallback, useEffect, useRef, useState } from 'react';

interface SpeechRecognitionAlternative {
  transcript: string;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent {
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent {
  readonly error: string;
}

interface SpeechRecognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionConstructor {
  new(): SpeechRecognition;
}

interface SpeechWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

function getSpeechRecognition(): SpeechRecognitionConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  const speechWindow = window as SpeechWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

function speechErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access blocked — allow it in your browser settings.';
    case 'no-speech':
      return "Didn't catch that — try speaking again.";
    case 'audio-capture':
      return 'No microphone found.';
    case 'network':
      return 'Network error during voice input.';
    default:
      return "Voice input isn't available right now.";
  }
}

export function useSpeechInput(): {
  supported: boolean;
  listening: boolean;
  error: string | null;
  start: (onText: (text: string, isFinal: boolean) => void) => void;
  stop: () => void;
} {
  const [listening, setListening] = useState(false);
  const [supported] = useState(() => getSpeechRecognition() !== undefined);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const recognitionGenerationRef = useRef(0);

  const start = useCallback((onText: (text: string, isFinal: boolean) => void): void => {
    const Ctor = getSpeechRecognition();
    if (!Ctor || recognitionRef.current) return;
    const generation = recognitionGenerationRef.current + 1;
    recognitionGenerationRef.current = generation;
    setError(null);
    const recognition = new Ctor();
    recognition.lang = navigator.language;
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      if (recognitionGenerationRef.current !== generation || recognitionRef.current !== recognition) return;
      const last = event.results[event.results.length - 1];
      if (last) onText(last[0].transcript, last.isFinal);
    };
    recognition.onerror = (event) => {
      if (recognitionGenerationRef.current !== generation || recognitionRef.current !== recognition) return;
      if (event.error === 'aborted') return;
      console.warn('voice error', event.error);
      setError(speechErrorMessage(event.error));
    };
    recognition.onend = () => {
      if (recognitionGenerationRef.current !== generation || recognitionRef.current !== recognition) return;
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, []);

  const stop = useCallback((): void => {
    recognitionGenerationRef.current += 1;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }, []);

  useEffect(() => () => {
    recognitionGenerationRef.current += 1;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
  }, []);

  return { supported, listening, error, start, stop };
}
