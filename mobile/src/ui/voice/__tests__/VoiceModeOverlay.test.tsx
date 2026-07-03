import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { VoiceModeOverlay } from '@/ui/voice/VoiceModeOverlay';
import type { AssistantItem } from '@/lib/timeline';

const speechInput = { supported: true, start: vi.fn(), stop: vi.fn() };
const speechOutput = {
  supported: true,
  speaking: false,
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

describe('VoiceModeOverlay thinking vs working (#177)', () => {
  it('shows "Thinking…" with a distinct glyph while the agent reasons (no tool running)', () => {
    const { panel, orb } = renderOverlay({ agentBusy: true, toolActive: false });
    expect(panel.getAttribute('data-state')).toBe('thinking');
    expect(orb.textContent).toContain('⋯');
  });

  it('shows "Working…" with a distinct glyph while a tool is running', () => {
    const { panel, orb } = renderOverlay({ agentBusy: true, toolActive: true });
    expect(panel.getAttribute('data-state')).toBe('working');
    expect(orb.textContent).toContain('⚙');
  });

  it('switches thinking → working when a tool starts mid-turn', () => {
    const { panel, rerender } = renderOverlay({ agentBusy: true, toolActive: false });
    expect(panel.getAttribute('data-state')).toBe('thinking');
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

describe('VoiceModeOverlay interrupt while busy (#179)', () => {
  it('interrupts the agent when the orb is tapped during thinking', () => {
    const { orb, onInterrupt } = renderOverlay({ agentBusy: true, toolActive: false });
    fireEvent.click(orb);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(speechOutput.cancel).toHaveBeenCalled();
  });

  it('interrupts the agent when the orb is tapped during working', () => {
    const { orb, onInterrupt } = renderOverlay({ agentBusy: true, toolActive: true });
    fireEvent.click(orb);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(speechInput.start).toHaveBeenCalled();
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
});
