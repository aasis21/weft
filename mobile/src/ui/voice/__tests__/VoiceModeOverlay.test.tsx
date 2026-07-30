import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { VoiceModeOverlay } from '@/ui/voice/VoiceModeOverlay';
import type { AssistantItem } from '@/lib/timeline';

const speechInput = { supported: true, start: vi.fn(), stop: vi.fn() };
const speechOutput = {
  supported: true,
  speaking: false,
  pending: false,
  hasOutstandingSpeech: (): boolean => speechOutput.speaking || speechOutput.pending,
  enqueue: vi.fn(),
  flush: vi.fn(),
  cancel: vi.fn(),
};

vi.mock('@/ui/hooks/useSpeechInput', () => ({ useSpeechInput: () => speechInput }));
vi.mock('@/ui/hooks/useSpeechOutput', () => ({ useSpeechOutput: () => speechOutput }));

function mkAssistant(text: string, final: boolean, id = 'm1'): AssistantItem {
  return { kind: 'assistant', id, text, ts: 1, final };
}

function renderOverlay(props: Partial<React.ComponentProps<typeof VoiceModeOverlay>> = {}) {
  const onInterrupt = vi.fn();
  const onPrompt = vi.fn();
  const utils = render(
    <VoiceModeOverlay
      latestAssistant={null}
      agentBusy={false}
      toolActive={false}
      disabled={false}
      onPrompt={onPrompt}
      onInterrupt={onInterrupt}
      onClose={vi.fn()}
      {...props}
    />,
  );
  const orb = utils.container.querySelector('.voice-orb') as HTMLButtonElement;
  const panel = utils.container.querySelector('.voice-panel') as HTMLDivElement;
  return { ...utils, orb, panel, onInterrupt };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('VoiceModeOverlay hands-free entry', () => {
  it('auto-starts listening on open when the mic is usable and no turn is in flight', () => {
    const { panel } = renderOverlay({ agentBusy: false, toolActive: false });
    expect(speechInput.start).toHaveBeenCalledTimes(1);
    expect(panel.getAttribute('data-state')).toBe('listening');
  });

  it('does not auto-start while a turn is already in flight (opened mid-turn)', () => {
    renderOverlay({ agentBusy: true, toolActive: false });
    expect(speechInput.start).not.toHaveBeenCalled();
  });
});

describe('VoiceModeOverlay one busy state (#183)', () => {
  it('shows "Working…" while the agent reasons (no tool running)', () => {
    const { panel, orb } = renderOverlay({ agentBusy: true, toolActive: false });
    expect(panel.getAttribute('data-state')).toBe('working');
    expect(orb.textContent).toContain('⚙');
  });

  it('shows "Working…" while a tool is running', () => {
    const { panel, orb } = renderOverlay({ agentBusy: true, toolActive: true });
    expect(panel.getAttribute('data-state')).toBe('working');
    expect(orb.textContent).toContain('⚙');
  });

  it('stays on working when a tool starts mid-turn — the label never flips', () => {
    const { panel, rerender } = renderOverlay({ agentBusy: true, toolActive: false });
    expect(panel.getAttribute('data-state')).toBe('working');
    rerender(
      <VoiceModeOverlay
        latestAssistant={null}
        agentBusy
        toolActive
        disabled={false}
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(panel.getAttribute('data-state')).toBe('working');
  });
});

describe('VoiceModeOverlay tapping the orb while busy (#179)', () => {
  it('opens the mic without cutting the agent off when no tool is running', () => {
    // Tapping used to be swallowed by startListening's busy-guard, then was made to interrupt.
    // It now records over the running turn and steers it with what you say, so a follow-up thought
    // costs you nothing that was already in flight.
    const { orb, onInterrupt } = renderOverlay({ agentBusy: true, toolActive: false });
    fireEvent.click(orb);
    expect(speechInput.start).toHaveBeenCalled();
    expect(speechOutput.cancel).toHaveBeenCalled();
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it('does the same while a tool is running', () => {
    const { orb, onInterrupt } = renderOverlay({ agentBusy: true, toolActive: true });
    fireEvent.click(orb);
    expect(speechInput.start).toHaveBeenCalled();
    expect(onInterrupt).not.toHaveBeenCalled();
  });
});

describe('VoiceModeOverlay full-message speech (streaming off, default)', () => {
  it('does not speak partial deltas while the message is still streaming', async () => {
    const { rerender } = renderOverlay({ agentBusy: true, latestAssistant: null });
    await Promise.resolve();
    rerender(
      <VoiceModeOverlay
        latestAssistant={mkAssistant('Hello wor', false)}
        agentBusy
        toolActive={false}
        disabled={false}
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(speechOutput.enqueue).not.toHaveBeenCalled();
  });

  it('speaks the whole message once it is finalized (assistant_message)', async () => {
    const { rerender } = renderOverlay({ agentBusy: true, latestAssistant: null });
    await Promise.resolve();
    rerender(
      <VoiceModeOverlay
        latestAssistant={mkAssistant('Hello wor', false)}
        agentBusy
        toolActive={false}
        disabled={false}
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(speechOutput.enqueue).not.toHaveBeenCalled();
    rerender(
      <VoiceModeOverlay
        latestAssistant={mkAssistant('Hello world.', true)}
        agentBusy
        toolActive={false}
        disabled={false}
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(speechOutput.enqueue).toHaveBeenCalledWith('Hello world.');
  });

  it('never speaks an empty / whitespace-only finalized message', async () => {
    const { rerender } = renderOverlay({ agentBusy: true, latestAssistant: null });
    await Promise.resolve();
    rerender(
      <VoiceModeOverlay
        latestAssistant={mkAssistant('   ', true)}
        agentBusy={false}
        toolActive={false}
        disabled={false}
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(speechOutput.enqueue).not.toHaveBeenCalled();
  });

  it('speaks the held narration when a tool starts, before showing Working…', async () => {
    const { rerender } = renderOverlay({ agentBusy: true, toolActive: false, latestAssistant: null });
    await Promise.resolve();
    // Narration streams in (not finalized) while the agent is busy — held.
    rerender(
      <VoiceModeOverlay
        latestAssistant={mkAssistant('Let me read the file.', false)}
        agentBusy
        toolActive={false}
        disabled={false}
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(speechOutput.enqueue).not.toHaveBeenCalled();
    // A tool starts — the narration so far is spoken first.
    rerender(
      <VoiceModeOverlay
        latestAssistant={mkAssistant('Let me read the file.', false)}
        agentBusy
        toolActive
        disabled={false}
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(speechOutput.enqueue).toHaveBeenCalledWith('Let me read the file.');
  });

  it('speaks each stretch of text between tools while the agent runs the next one', async () => {
    // A turn is text, tool, text, tool… Each stretch is a finished thought once the next tool
    // starts, so it is spoken then rather than being held to the end of the whole turn — and the
    // half-written stretch that follows stays held while that tool runs, because the release is the
    // tool's rising edge and not "a tool is running".
    const render = (text: string, toolActive: boolean) =>
      rerender(
        <VoiceModeOverlay
          latestAssistant={mkAssistant(text, false)}
          agentBusy
          toolActive={toolActive}
          disabled={false}
          onPrompt={vi.fn()}
          onInterrupt={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    const { rerender } = renderOverlay({ agentBusy: true, toolActive: false, latestAssistant: null });
    await Promise.resolve();

    render('First I will read the file.', false);
    expect(speechOutput.enqueue).not.toHaveBeenCalled();

    render('First I will read the file.', true);
    expect(speechOutput.enqueue).toHaveBeenCalledWith('First I will read the file.');

    // Second stretch arrives while that same tool is still running — still a half-written thought.
    render('First I will read the file. Now I will patch it.', true);
    expect(speechOutput.enqueue).toHaveBeenCalledTimes(1);

    // Tool ends, the next one starts: the second stretch is finished and gets spoken while the
    // agent is already busy with the new tool call.
    render('First I will read the file. Now I will patch it.', false);
    render('First I will read the file. Now I will patch it.', true);
    expect(speechOutput.enqueue).toHaveBeenCalledWith(' Now I will patch it.');
    expect(speechOutput.enqueue).toHaveBeenCalledTimes(2);
  });
});

describe('VoiceModeOverlay exits (#186)', () => {
  it('separates collapsing back to the dock from leaving Vox entirely', () => {
    const onClose = vi.fn();
    const onExit = vi.fn();
    const { getByText } = renderOverlay({ onClose, onExit });
    fireEvent.click(getByText('Collapse'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
    fireEvent.click(getByText('Back to chat'));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('picks up the sentence handed over from the dock', () => {
    const { container } = renderOverlay({ initialTranscript: 'open the' });
    expect(container.querySelector('.voice-caption')?.textContent).toContain('open the');
  });
});
