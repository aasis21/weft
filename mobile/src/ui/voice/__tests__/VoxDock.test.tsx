import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { VoxDock } from '@/ui/voice/VoxDock';

const speechInput = { supported: true, listening: false, error: null as string | null, start: vi.fn(), stop: vi.fn() };
const speechOutput = {
  supported: true,
  speaking: false,
  enqueue: vi.fn(),
  flush: vi.fn(),
  cancel: vi.fn(),
};

vi.mock('@/ui/hooks/useSpeechInput', () => ({ useSpeechInput: () => speechInput }));
vi.mock('@/ui/hooks/useSpeechOutput', () => ({ useSpeechOutput: () => speechOutput }));

function renderDock(props: Partial<React.ComponentProps<typeof VoxDock>> = {}) {
  const onPrompt = vi.fn();
  const onExpand = vi.fn();
  const onKeyboard = vi.fn();
  const onEditTranscript = vi.fn();
  const utils = render(
    <VoxDock
      latestAssistant={null}
      agentBusy={false}
      toolActive={false}
      disabled={false}
      onPrompt={onPrompt}
      onInterrupt={vi.fn()}
      onExpand={onExpand}
      onKeyboard={onKeyboard}
      onEditTranscript={onEditTranscript}
      {...props}
    />,
  );
  const panel = utils.container.querySelector('.vox-dock') as HTMLDivElement;
  return { ...utils, panel, onPrompt, onExpand, onKeyboard, onEditTranscript };
}

/** Drive the transcript callback the dock handed to the speech recognizer. */
function speak(text: string, isFinal: boolean): void {
  const onText = speechInput.start.mock.calls.at(-1)?.[0] as ((t: string, f: boolean) => void) | undefined;
  act(() => onText?.(text, isFinal));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  speechInput.error = null;
});

describe('VoxDock inline surface', () => {
  it('renders in place (no modal dialog) and auto-starts listening', () => {
    const { panel, container } = renderDock();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(speechInput.start).toHaveBeenCalledTimes(1);
    expect(panel.getAttribute('data-state')).toBe('listening');
  });

  it('escalates to the full-page surface via the expand button', () => {
    const { getByLabelText, onExpand } = renderDock();
    fireEvent.click(getByLabelText('Expand Vox to full screen'));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('leaves Vox via the keyboard button in the dock head, not the send slot', () => {
    const { container, getByLabelText, onKeyboard } = renderDock();
    const keyboard = getByLabelText('Switch to typing');
    expect(container.querySelector('.vox-dock-head')?.contains(keyboard)).toBe(true);
    fireEvent.click(keyboard);
    expect(onKeyboard).toHaveBeenCalledTimes(1);
  });

  it('hands the heard words to the text box when the caption is tapped', () => {
    const { container, onEditTranscript } = renderDock();
    speak('delete the temp folder', false);
    const heard = container.querySelector('button.vox-heard') as HTMLButtonElement;
    expect(heard.textContent).toContain('delete the temp folder');
    fireEvent.click(heard);
    expect(onEditTranscript).toHaveBeenCalledWith('delete the temp folder');
  });

  it('surfaces mic errors instead of swallowing them', () => {
    speechInput.error = 'Microphone access blocked — allow it in your browser settings.';
    const { container } = renderDock();
    expect(container.querySelector('.vox-dock-error')?.textContent).toContain('Microphone access blocked');
  });
});

describe('VoxDock quiet while busy (#183)', () => {
  it('hides the status line and transcript once the turn is in flight', () => {
    const { container, panel } = renderDock({ agentBusy: true });
    expect(panel.getAttribute('data-state')).toBe('working');
    expect(container.querySelector('.vox-dock-status')).toBeNull();
    expect(container.querySelector('.vox-heard')).toBeNull();
  });

  it('still shows the words while the mic is on', () => {
    const { container } = renderDock();
    speak('run the tests', false);
    expect(container.querySelector('.vox-dock-status')?.textContent).toContain('Listening');
    expect(container.querySelector('.vox-heard')?.textContent).toContain('run the tests');
  });
});

describe('VoxDock approval priority', () => {
  it('does not take the mic while an approval is waiting', () => {
    const { panel } = renderDock({ paused: true });
    expect(speechInput.start).not.toHaveBeenCalled();
    expect(panel.getAttribute('data-paused')).toBe('true');
  });

  it('drops the mic when an approval arrives mid-listen', () => {
    const { rerender, panel } = renderDock();
    expect(panel.getAttribute('data-state')).toBe('listening');
    rerender(
      <VoxDock
        latestAssistant={null}
        agentBusy={false}
        toolActive={false}
        disabled={false}
        paused
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onExpand={vi.fn()}
        onKeyboard={vi.fn()}
        onEditTranscript={vi.fn()}
      />,
    );
    expect(speechInput.stop).toHaveBeenCalled();
    expect(panel.getAttribute('data-paused')).toBe('true');
  });
});

describe('VoxDock transcript loss (#voice-transcript-loss)', () => {
  it('sends the words on screen even when no final result arrived before the silence timer', () => {
    vi.useFakeTimers();
    const { onPrompt } = renderDock();
    speak('run the tests', false); // interim only — the recognizer never finalized
    act(() => {
      vi.advanceTimersByTime(3300);
    });
    expect(onPrompt).toHaveBeenCalledWith('run the tests');
  });
});
