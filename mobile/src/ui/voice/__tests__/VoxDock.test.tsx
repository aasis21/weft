import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { VoxDock } from '@/ui/voice/VoxDock';

const speechInput = { supported: true, listening: false, error: null as string | null, start: vi.fn(), stop: vi.fn() };
const speechOutput = {
  supported: true,
  speaking: false,
  pending: false,
  // Mirrors the real hook's synchronous ref-read: whatever `speaking`/`pending` say RIGHT NOW,
  // without waiting for a re-render. Tests toggle the fields directly, so reading them here is
  // exactly the "truth ahead of React state" the engine depends on.
  hasOutstandingSpeech: (): boolean => speechOutput.speaking || speechOutput.pending,
  enqueue: vi.fn(),
  flush: vi.fn(),
  cancel: vi.fn(),
};

/** A finished reply. Cast like the other fixtures here — the tests only ever read id and text. */
const settledReply = { id: 'a1', text: 'All done.' } as never;

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
  speechOutput.speaking = false;
  speechOutput.pending = false;
});

describe('Vox keeps its turn (#195)', () => {
  it('records over a busy agent and steers the running turn rather than queueing behind it', () => {
    // Mid-turn speech is nearly always a redirection of the work in flight, so it goes out as a
    // normal immediate send -- which the SDK applies to the turn already running. Queueing stays an
    // explicit choice on the composer's queue button.
    vi.useFakeTimers();
    const onPrompt = vi.fn();
    const onInterrupt = vi.fn();
    const { panel, getByRole } = renderDock({ agentBusy: true, onPrompt, onInterrupt });

    expect(panel.getAttribute('data-state')).toBe('working');

    fireEvent.click(getByRole('button', { name: /working/i }));
    expect(panel.getAttribute('data-state')).toBe('listening');
    expect(onInterrupt).not.toHaveBeenCalled();

    speak('actually check the other branch first', true);
    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(onPrompt).toHaveBeenCalledWith('actually check the other branch first');
  });

  it('stays on working after sending, instead of reopening the mic before the turn starts', () => {
    vi.useFakeTimers();
    const { panel, onPrompt } = renderDock();

    speak('restart the build', true);
    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(onPrompt).toHaveBeenCalledWith('restart the build');
    // agentBusy is still false — the laptop hasn't reported the turn yet. Vox must hold, not settle
    // out and grab the mic in time to transcribe its own reply.
    expect(panel.getAttribute('data-state')).toBe('working');
    expect(speechInput.start).toHaveBeenCalledTimes(1);
  });

  it('settles instead of hanging on working when the turn never starts', () => {
    vi.useFakeTimers();
    const { panel } = renderDock();

    speak('are you there', true);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(panel.getAttribute('data-state')).toBe('working');

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    // The turn-start grace expiring only re-opens the question; settling then waits out its own
    // quiet window (#196) so a reply landing a beat late still gets spoken.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(panel.getAttribute('data-state')).toBe('ready');
  });

  it('settles once speech drains even though a reply was spoken this turn', () => {
    vi.useFakeTimers();
    speechOutput.pending = true;
    const { panel, rerender } = renderDock({ agentBusy: true, latestAssistant: settledReply });

    expect(panel.getAttribute('data-state')).toBe('working');

    // Turn ends and the queue drains without `speaking` ever flipping — the engine took the text
    // and made no sound. Vox used to sit on working… forever from here.
    speechOutput.pending = false;
    act(() => {
      rerender(
        <VoxDock
          latestAssistant={{ id: 'a1', text: 'All done.' }}
          agentBusy={false}
          toolActive={false}
          disabled={false}
          onPrompt={vi.fn()}
          onInterrupt={vi.fn()}
          onExpand={vi.fn()}
          onKeyboard={vi.fn()}
          onEditTranscript={vi.fn()}
        />,
      );
      vi.advanceTimersByTime(1000);
    });

    // Vox opened mid-turn, so its hands-free first listen was held back; with the turn now over it
    // takes the mic. Either way the point stands — it is off working…, not stuck on it.
    expect(panel.getAttribute('data-state')).toBe('listening');
  });

  it('does not settle on a turn whose last sentence is still queued to speak (#196)', () => {
    vi.useFakeTimers();
    speechOutput.pending = true;
    const { panel, rerender } = renderDock({ agentBusy: true, latestAssistant: settledReply });

    // The turn goes idle in the same breath as the reply is handed to TTS. Settling here would call
    // startListening(), which opens by cancelling speech — destroying the reply before it is said.
    act(() => {
      rerender(
        <VoxDock
          latestAssistant={{ id: 'a1', text: 'All done.' }}
          agentBusy={false}
          toolActive={false}
          disabled={false}
          onPrompt={vi.fn()}
          onInterrupt={vi.fn()}
          onExpand={vi.fn()}
          onKeyboard={vi.fn()}
          onEditTranscript={vi.fn()}
        />,
      );
      vi.advanceTimersByTime(2000);
    });

    expect(panel.getAttribute('data-state')).toBe('working');
    expect(speechOutput.cancel).not.toHaveBeenCalled();
  });
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

  it('shows the run once, not once per update (#192)', () => {
    const { container } = renderDock();
    const heard = (): string => container.querySelector('button.vox-heard')?.textContent ?? '';

    // The recognizer reports everything heard so far on every update, so each one replaces the
    // last. Treating them as fragments to append turned "hey man" into "hey heyman".
    speak('hey', true);
    speak('hey man', true);
    speak("hey man what's up", false);

    expect(heard()).toContain("hey man what's up");
    expect(heard()).not.toContain('heyhey');
    expect(heard()).not.toContain('hey hey');
  });

  it('surfaces mic errors instead of swallowing them', () => {
    speechInput.error = 'Microphone access blocked — allow it in your browser settings.';
    const { container } = renderDock();
    expect(container.querySelector('.vox-dock-error')?.textContent).toContain('Microphone access blocked');
  });
});

describe('VoxDock quiet while busy (#183)', () => {  it('hides the status line and transcript once the turn is in flight', () => {
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

describe('VoxDock reports state upward (#184)', () => {
  it('tells the header when the mic opens and when the turn goes out', () => {
    vi.useFakeTimers();
    const onStateChange = vi.fn();
    renderDock({ onStateChange });
    expect(onStateChange).toHaveBeenLastCalledWith('listening');
    speak('ship it', true);
    act(() => {
      vi.advanceTimersByTime(3300);
    });
    expect(onStateChange).toHaveBeenCalledWith('working');
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

describe('VoxDock quick settings and countdown (#186)', () => {
  it('opens the two knobs worth reaching for mid-conversation', () => {
    const { container, getByLabelText } = renderDock();
    expect(container.querySelector('.vox-settings')).toBeNull();
    fireEvent.click(getByLabelText('Vox settings'));
    const panel = container.querySelector('.vox-settings');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('Keep listening');
    // The language belongs in Settings — it is chosen once, not reached for mid-conversation.
    expect(panel?.textContent).not.toContain('Speech language');
    // Segments, not a slider — this gets used at arm's length.
    expect(panel?.querySelectorAll('.settings-segment').length).toBe(4);
  });

  it('drives the countdown from the silence setting and replays it on every new word', () => {
    const { container } = renderDock();
    speak('one', false);
    const bar = container.querySelector('.voice-countdown') as HTMLDivElement;
    expect(bar.className).toContain('active');
    expect(bar.style.getPropertyValue('--voice-countdown-duration')).toBe('3200ms');
    const first = bar.querySelector('span');
    speak('one two', false);
    // A fresh element means the CSS animation restarts instead of sitting at empty.
    expect(bar.querySelector('span')).not.toBe(first);
  });

  it('resumes the sentence handed over from the surface it replaced', () => {
    const { container } = renderDock({ initialTranscript: 'deploy the' });
    expect(container.querySelector('.vox-heard')?.textContent).toContain('deploy the');
    speak('deploy the build', false);
    expect(container.querySelector('.vox-heard')?.textContent).toContain('deploy the build');
  });

  it('reports the in-flight words so a swap can carry them across', () => {
    const onTranscriptHandoff = vi.fn();
    renderDock({ onTranscriptHandoff });
    speak('hold on', false);
    expect(onTranscriptHandoff).toHaveBeenLastCalledWith('hold on');
  });
});

describe('VoxDock follows the chat you switch to (#187)', () => {
  function dockFor(conversationKey: string, latestAssistant: React.ComponentProps<typeof VoxDock>['latestAssistant']) {
    return (
      <VoxDock
        latestAssistant={latestAssistant}
        agentBusy={false}
        toolActive={false}
        disabled={false}
        conversationKey={conversationKey}
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onExpand={vi.fn()}
        onKeyboard={vi.fn()}
        onEditTranscript={vi.fn()}
      />
    );
  }

  it('stays open and reopens the mic on the new chat', () => {
    const { rerender, container } = render(dockFor('chat-a', null));
    speak('this was for the old chat', false);
    expect(speechInput.start).toHaveBeenCalledTimes(1);

    rerender(dockFor('chat-b', null));

    expect(container.querySelector('.vox-dock')).not.toBeNull();
    expect(speechInput.start).toHaveBeenCalledTimes(2);
    // Words meant for the previous chat don't follow you into the new one.
    expect(container.querySelector('.vox-heard')?.textContent).not.toContain('old chat');
  });

  it('does not read out the reply that was already sitting in the new chat', () => {
    const oldReply = { id: 'a1', kind: 'assistant', text: 'done with chat A', final: true } as never;
    const newReply = { id: 'b1', kind: 'assistant', text: 'a stale answer from chat B', final: true } as never;
    const { rerender } = render(dockFor('chat-a', oldReply));
    speechOutput.enqueue.mockClear();

    rerender(dockFor('chat-b', newReply));

    expect(speechOutput.enqueue).not.toHaveBeenCalled();
  });
});

describe('VoxDock does not barge into a busy chat (#188)', () => {  function dock(conversationKey: string, agentBusy: boolean, latestAssistant: React.ComponentProps<typeof VoxDock>['latestAssistant']) {
    return (
      <VoxDock
        latestAssistant={latestAssistant}
        agentBusy={agentBusy}
        toolActive={false}
        disabled={false}
        conversationKey={conversationKey}
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onExpand={vi.fn()}
        onKeyboard={vi.fn()}
        onEditTranscript={vi.fn()}
      />
    );
  }

  it('holds the mic when the chat you switch to is mid-turn', () => {
    const { rerender, container } = render(dock('chat-a', false, null));
    expect(speechInput.start).toHaveBeenCalledTimes(1);

    rerender(dock('chat-b', true, null));

    expect(speechInput.start).toHaveBeenCalledTimes(1);
    expect(speechInput.stop).toHaveBeenCalled();
    expect(container.querySelector('.vox-dock')?.getAttribute('data-state')).toBe('working');
  });

  it('stays silent through the turn it walked in on, then joins in', () => {
    const growing = { id: 'b1', kind: 'assistant', text: 'half an answer', final: false } as never;
    const landed = { id: 'b1', kind: 'assistant', text: 'half an answer and the rest', final: true } as never;
    const { rerender } = render(dock('chat-a', false, null));
    speechOutput.enqueue.mockClear();

    rerender(dock('chat-b', true, growing));
    expect(speechOutput.enqueue).not.toHaveBeenCalled();

    rerender(dock('chat-b', false, landed));
    // The turn we interrupted is swallowed whole, not read out after the fact.
    expect(speechOutput.enqueue).not.toHaveBeenCalled();

    const next = { id: 'b2', kind: 'assistant', text: 'this one is ours', final: true } as never;
    rerender(dock('chat-b', false, next));
    expect(speechOutput.enqueue).toHaveBeenCalledWith('this one is ours');
  });

  it('never leaves the mic open outside listening (#189)', () => {    const reply = { id: 'b1', kind: 'assistant', text: 'talking now', final: true } as never;
    const { rerender, container } = render(dock('chat-a', false, null));

    // The safety net must not undo the auto-start it shares a commit with.
    expect(container.querySelector('.vox-dock')?.getAttribute('data-state')).toBe('listening');
    expect(speechInput.start).toHaveBeenCalledTimes(1);
    expect(speechInput.stop).not.toHaveBeenCalled();

    // Standing by in a busy chat: the mic must be released, not merely asked to wind down.
    rerender(dock('chat-b', true, null));
    expect(container.querySelector('.vox-dock')?.getAttribute('data-state')).toBe('working');
    expect(speechInput.stop).toHaveBeenCalled();

    // And it stays released while the assistant speaks — no restart sneaks in behind the audio.
    rerender(dock('chat-b', true, reply));
    expect(speechInput.start).toHaveBeenCalledTimes(1);
  });
});
