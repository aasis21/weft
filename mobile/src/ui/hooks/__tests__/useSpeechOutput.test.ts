import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { splitSpeechSentences, useSpeechOutput } from '@/ui/hooks/useSpeechOutput';

class UtteranceMock {
  text: string;
  rate = 1;
  pitch = 1;
  onstart: (() => void) | null = null;
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

  it('reports pending while a reply is still buffered, queued, or mid-utterance (#195)', () => {
    const { result } = renderHook(() => useSpeechOutput());
    const synth = window.speechSynthesis as SpeechSynthesis & { spoken: UtteranceMock[] };

    expect(result.current.pending).toBe(false);

    // Buffered text with no sentence end yet still counts — it will be spoken on flush.
    act(() => result.current.enqueue('half a thought'));
    expect(synth.spoken).toHaveLength(0);
    expect(result.current.pending).toBe(true);

    act(() => result.current.flush());
    expect(synth.spoken).toHaveLength(1);
    expect(result.current.pending).toBe(true);

    act(() => synth.spoken[0].onend?.());
    expect(result.current.pending).toBe(false);
    expect(result.current.speaking).toBe(false);
  });

  it('ignores callbacks from an utterance that cancel already abandoned (#195)', () => {
    const { result } = renderHook(() => useSpeechOutput());
    const synth = window.speechSynthesis as SpeechSynthesis & { spoken: UtteranceMock[] };

    act(() => result.current.enqueue('one. two. '));
    expect(synth.spoken).toHaveLength(1);
    const abandoned = synth.spoken[0];

    // cancel() makes the engine fire onend/onerror on whatever was in flight. That callback must
    // not pull from the queue — by then it belongs to a different reply.
    act(() => result.current.cancel());
    act(() => result.current.enqueue('a fresh reply. '));
    expect(synth.spoken).toHaveLength(2);

    act(() => abandoned.onend?.());
    expect(synth.spoken).toHaveLength(2);
  });
});
