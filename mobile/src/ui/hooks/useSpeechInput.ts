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
  readonly resultIndex?: number;
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
  const explicitStopRef = useRef(true);
  const fatalErrorRef = useRef(false);

  const start = useCallback((onText: (text: string, isFinal: boolean) => void): void => {
    const Ctor = getSpeechRecognition();
    if (!Ctor || recognitionRef.current) return;
    const generation = recognitionGenerationRef.current + 1;
    recognitionGenerationRef.current = generation;
    explicitStopRef.current = false;
    fatalErrorRef.current = false;
    setError(null);

    const startRecognition = (): void => {
      if (recognitionGenerationRef.current !== generation || explicitStopRef.current || fatalErrorRef.current) return;
      const recognition = new Ctor();
      let finalTranscript = '';
      recognition.lang = navigator.language;
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;
      recognition.onresult = (event) => {
        if (recognitionGenerationRef.current !== generation || recognitionRef.current !== recognition) return;
        let interimTranscript = '';
        for (let index = event.resultIndex ?? 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result?.[0]?.transcript ?? '';
          if (result?.isFinal) finalTranscript += transcript;
          else interimTranscript += transcript;
        }
        const transcript = `${finalTranscript}${interimTranscript}`;
        if (transcript) onText(transcript, interimTranscript.length === 0);
      };
      recognition.onerror = (event) => {
        if (recognitionGenerationRef.current !== generation || recognitionRef.current !== recognition) return;
        if (event.error === 'aborted') return;
        console.warn('voice error', event.error);
        setError(speechErrorMessage(event.error));
        if (
          event.error === 'not-allowed' ||
          event.error === 'service-not-allowed' ||
          event.error === 'audio-capture' ||
          event.error === 'network'
        ) {
          fatalErrorRef.current = true;
        }
      };
      recognition.onend = () => {
        if (recognitionGenerationRef.current !== generation || recognitionRef.current !== recognition) return;
        recognitionRef.current = null;
        if (explicitStopRef.current || fatalErrorRef.current) {
          setListening(false);
          return;
        }
        startRecognition();
      };
      recognitionRef.current = recognition;
      setListening(true);
      recognition.start();
    };

    startRecognition();
  }, []);

  const stop = useCallback((): void => {
    explicitStopRef.current = true;
    recognitionGenerationRef.current += 1;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }, []);

  useEffect(() => () => {
    explicitStopRef.current = true;
    recognitionGenerationRef.current += 1;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
  }, []);

  return { supported, listening, error, start, stop };
}
