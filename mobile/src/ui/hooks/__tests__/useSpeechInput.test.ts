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
  abort = vi.fn();

  constructor() {
    MockSpeechRecognition.instances.push(this);
  }
}

/** One `onresult` payload. Real engines keep every result of the session in `results`, so callers
 *  pass the whole list as it stands, not just the newest piece. */
function speechEventAll(
  entries: Array<[string, boolean]>,
  resultIndex = 0,
): { results: ArrayLike<MockResult> & { item(index: number): MockResult }; resultIndex: number } {
  const results: Record<number, MockResult> = {};
  entries.forEach(([transcript, isFinal], index) => {
    results[index] = { isFinal, 0: { transcript } };
  });
  return {
    resultIndex,
    results: {
      ...results,
      length: entries.length,
      item(index: number) {
        return this[index];
      },
    } as ArrayLike<MockResult> & { item(index: number): MockResult },
  };
}

function speechEvent(
  transcript: string,
  isFinal: boolean,
): { results: ArrayLike<MockResult> & { item(index: number): MockResult }; resultIndex: number } {
  return speechEventAll([[transcript, isFinal]]);
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

  it('restarts after engine end and keeps reporting the whole run until explicitly stopped', async () => {
    const heard: Array<{ text: string; isFinal: boolean }> = [];
    const { result } = renderHook(() => useSpeechInput());

    act(() => {
      result.current.start((text, isFinal) => heard.push({ text, isFinal }));
    });

    expect(result.current.listening).toBe(true);
    expect(MockSpeechRecognition.instances).toHaveLength(1);
    expect(MockSpeechRecognition.instances[0].continuous).toBe(true);

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
    expect(heard.at(-1)).toEqual({ text: 'helloworld', isFinal: true });

    act(() => {
      result.current.stop();
    });
    act(() => {
      MockSpeechRecognition.instances[1].onend?.();
    });

    expect(result.current.listening).toBe(false);
    expect(MockSpeechRecognition.instances).toHaveLength(2);
  });

  it('aborts the engine on stop so nothing keeps listening (#189)', () => {
    const heard: Array<{ text: string; isFinal: boolean }> = [];
    const { result } = renderHook(() => useSpeechInput());

    act(() => {
      result.current.start((text, isFinal) => heard.push({ text, isFinal }));
    });
    const engine = MockSpeechRecognition.instances[0];

    act(() => {
      result.current.stop();
    });

    expect(engine.abort).toHaveBeenCalledTimes(1);
    expect(engine.stop).not.toHaveBeenCalled();
    expect(engine.onresult).toBeNull();
    expect(engine.onend).toBeNull();
    expect(engine.onerror).toBeNull();
    expect(heard).toEqual([]);
    expect(MockSpeechRecognition.instances).toHaveLength(1);
  });

  it('treats a silent pause as silence, not an error (#190)', () => {
    const { result } = renderHook(() => useSpeechInput());

    act(() => {
      result.current.start(() => {});
    });

    act(() => {
      MockSpeechRecognition.instances[0].onerror?.({ error: 'no-speech' });
    });

    expect(result.current.error).toBeNull();
    expect(result.current.listening).toBe(true);
  });

  it('reports the whole run, not a fragment, across engine restarts (#192)', async () => {
    const heard: Array<{ text: string; isFinal: boolean }> = [];
    const { result } = renderHook(() => useSpeechInput());

    act(() => {
      result.current.start((text, isFinal) => heard.push({ text, isFinal }));
    });

    // Continuous mode keeps every result of the session in the payload — each event carries
    // everything so far, so the text we report is rebuilt, not accumulated.
    act(() => {
      MockSpeechRecognition.instances[0].onresult?.(speechEventAll([['hey ', true]]));
      MockSpeechRecognition.instances[0].onresult?.(speechEventAll([['hey ', true], ['man', true]]));
    });
    expect(heard.at(-1)).toEqual({ text: 'hey man', isFinal: true });

    // Android re-delivers earlier results with a stale index while it revises them. A running tally
    // fed by that index re-adds what it already had; rebuilding from the list cannot.
    act(() => {
      MockSpeechRecognition.instances[0].onresult?.(
        speechEventAll([['hey ', true], ['man', true], [" what's up", false]], 0),
      );
    });
    expect(heard.at(-1)).toEqual({ text: "hey man what's up", isFinal: false });

    // A restart starts the engine's transcript over, so we carry the earlier text ourselves.
    act(() => {
      MockSpeechRecognition.instances[0].onresult?.(
        speechEventAll([['hey ', true], ['man', true], [" what's up", true]]),
      );
      MockSpeechRecognition.instances[0].onend?.();
    });
    await waitFor(() => expect(MockSpeechRecognition.instances).toHaveLength(2));

    act(() => {
      MockSpeechRecognition.instances[1].onresult?.(speechEvent(' doing well', true));
    });
    expect(heard.at(-1)).toEqual({ text: "hey man what's up doing well", isFinal: true });

    // A fresh listen starts from nothing.
    act(() => {
      result.current.stop();
      result.current.start((text, isFinal) => heard.push({ text, isFinal }));
    });
    act(() => {
      MockSpeechRecognition.instances.at(-1)?.onresult?.(speechEvent('brand new', true));
    });
    expect(heard.at(-1)).toEqual({ text: 'brand new', isFinal: true });
  });

  it('falls back to stop when the engine has no abort', () => {    const { result } = renderHook(() => useSpeechInput());

    act(() => {
      result.current.start(() => {});
    });
    const engine = MockSpeechRecognition.instances[0];
    (engine as { abort?: unknown }).abort = undefined;

    act(() => {
      result.current.stop();
    });

    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(result.current.listening).toBe(false);
  });
});
