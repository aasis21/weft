import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { splitSpeechSentences, useSpeechOutput } from '@/ui/hooks/useSpeechOutput';

class UtteranceMock {
  text: string;
  rate = 1;
  pitch = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

describe('useSpeechOutput', () => {
  beforeEach(() => {
    const spoken: UtteranceMock[] = [];
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: UtteranceMock });
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      writable: true,
      value: {
        spoken,
        speak: vi.fn((utterance: UtteranceMock) => {
          spoken.push(utterance);
        }),
        cancel: vi.fn(),
      },
    });
  });

  it('splits sentence chunks and keeps trailing partial text', () => {
    expect(splitSpeechSentences('Hello there. Still typing')).toEqual({
      sentences: ['Hello there.'],
      rest: 'Still typing',
    });
  });

  it('queues complete sentences and cancel clears playback', () => {
    const { result } = renderHook(() => useSpeechOutput());
    const synth = window.speechSynthesis as SpeechSynthesis & { spoken: UtteranceMock[]; cancel: ReturnType<typeof vi.fn> };

    act(() => result.current.enqueue('Hello'));
    expect(synth.speak).not.toHaveBeenCalled();

    act(() => result.current.enqueue(' world. Next'));
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(synth.spoken[0].text).toBe('Hello world.');

    act(() => result.current.cancel());
    expect(synth.cancel).toHaveBeenCalledTimes(1);
    expect(result.current.speaking).toBe(false);
  });
});
