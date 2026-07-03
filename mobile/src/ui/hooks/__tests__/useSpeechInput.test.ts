import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpeechInput } from '@/ui/hooks/useSpeechInput';

interface MockResult {
  isFinal: boolean;
  0: { transcript: string };
}

class MockSpeechRecognition {
  static instances: MockSpeechRecognition[] = [];

  lang = '';
  interimResults = false;
  continuous = true;
  maxAlternatives = 0;
  onresult: ((event: { results: ArrayLike<MockResult>; resultIndex: number }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();

  constructor() {
    MockSpeechRecognition.instances.push(this);
  }
}

function speechEvent(transcript: string, isFinal: boolean): { results: ArrayLike<MockResult>; resultIndex: number } {
  return {
    resultIndex: 0,
    results: {
      0: { isFinal, 0: { transcript } },
      length: 1,
      item(index: number) {
        return this[index];
      },
    },
  };
}

describe('useSpeechInput', () => {
  beforeEach(() => {
    MockSpeechRecognition.instances = [];
    Object.defineProperty(window, 'SpeechRecognition', {
      configurable: true,
      writable: true,
      value: MockSpeechRecognition,
    });
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'en-US',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (window as { SpeechRecognition?: unknown }).SpeechRecognition;
  });

  it('restarts after engine end with a fresh transcript buffer until explicitly stopped', async () => {
    const heard: Array<{ text: string; isFinal: boolean }> = [];
    const { result } = renderHook(() => useSpeechInput());

    act(() => {
      result.current.start((text, isFinal) => heard.push({ text, isFinal }));
    });

    expect(result.current.listening).toBe(true);
    expect(MockSpeechRecognition.instances).toHaveLength(1);
    expect(MockSpeechRecognition.instances[0].continuous).toBe(false);

    act(() => {
      MockSpeechRecognition.instances[0].onresult?.(speechEvent('hello', false));
      MockSpeechRecognition.instances[0].onresult?.(speechEvent('hello', true));
    });
    expect(heard).toEqual([
      { text: 'hello', isFinal: false },
      { text: 'hello', isFinal: true },
    ]);

    act(() => {
      MockSpeechRecognition.instances[0].onend?.();
    });
    await waitFor(() => expect(MockSpeechRecognition.instances).toHaveLength(2));
    expect(result.current.listening).toBe(true);

    act(() => {
      MockSpeechRecognition.instances[1].onresult?.(speechEvent('world', true));
    });
    expect(heard.at(-1)).toEqual({ text: 'world', isFinal: true });

    act(() => {
      result.current.stop();
    });
    act(() => {
      MockSpeechRecognition.instances[1].onend?.();
    });

    expect(result.current.listening).toBe(false);
    expect(MockSpeechRecognition.instances).toHaveLength(2);
  });
});
