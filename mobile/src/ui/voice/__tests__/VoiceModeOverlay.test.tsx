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
  speechOutput.speaking = false;
  speechOutput.pending = false;
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

describe('VoiceModeOverlay speech keeps up with the agent (streaming off, default)', () => {
  it('hands text to the speech queue as it arrives, without waiting for the message to finalize', async () => {
    // The queue is what decides what is speakable — it splits on sentence boundaries and buffers
    // any trailing fragment — so holding text here only ever added delay. Speaking takes real time,
    // and a held backlog means silence while the agent races ahead.
    const { rerender } = renderOverlay({ agentBusy: true, latestAssistant: null });
    await Promise.resolve();
    rerender(
      <VoiceModeOverlay
        latestAssistant={mkAssistant('Hello world. And ano', false)}
        agentBusy
        toolActive={false}
        disabled={false}
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(speechOutput.enqueue).toHaveBeenCalledWith('Hello world. And ano');
  });

  it('keeps feeding the queue while a tool runs', async () => {
    const { rerender } = renderOverlay({ agentBusy: true, toolActive: false, latestAssistant: null });
    await Promise.resolve();
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

    render('First I will read the file.', false);
    expect(speechOutput.enqueue).toHaveBeenCalledWith('First I will read the file.');

    // A tool starts and more text lands while it is still running — both keep flowing.
    render('First I will read the file. Now I will patch it.', true);
    expect(speechOutput.enqueue).toHaveBeenCalledWith(' Now I will patch it.');
    expect(speechOutput.enqueue).toHaveBeenCalledTimes(2);
  });

  it('never speaks an empty / whitespace-only message', async () => {
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
});

describe('VoiceModeOverlay speaking over a running turn', () => {
  it('says that the agent is still working, rather than letting the voice hide it', () => {
    speechOutput.speaking = true;
    const { panel } = renderOverlay({ agentBusy: true, toolActive: false });
    expect(panel.getAttribute('data-state')).toBe('speaking');
    expect(panel.getAttribute('data-working')).toBe('true');
    expect(panel.textContent).toContain('Speaking — agent still working');
  });

  it('stops the speech without killing the turn behind it', () => {
    // A tap during speech means "stop talking". It used to also interrupt, which was survivable
    // when speech only briefly outlived the work — now that overlap is normal, it would routinely
    // throw away a running turn.
    speechOutput.speaking = true;
    const { orb, onInterrupt } = renderOverlay({ agentBusy: true, toolActive: false });
    fireEvent.click(orb);
    expect(speechOutput.cancel).toHaveBeenCalled();
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it('still interrupts when the turn is already over', () => {
    speechOutput.speaking = true;
    const { orb, onInterrupt } = renderOverlay({ agentBusy: false, toolActive: false });
    fireEvent.click(orb);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('marks the orb itself, not just the panel colour, while it speaks over live work', () => {
    // The dock hides its status line in exactly these two states, so colour alone was carrying the
    // "still working" fact there. The pip gives both surfaces something non-chromatic to read.
    speechOutput.speaking = true;
    const { orb } = renderOverlay({ agentBusy: true, toolActive: false });
    expect(orb.querySelector('.voice-orb-working')).toBeTruthy();
  });

  it('drops that marker once the turn actually ends', () => {
    speechOutput.speaking = true;
    const { orb } = renderOverlay({ agentBusy: false, toolActive: false });
    expect(orb.querySelector('.voice-orb-working')).toBeNull();
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
