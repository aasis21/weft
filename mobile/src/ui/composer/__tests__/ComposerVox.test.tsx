import { render, fireEvent, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { SessionMode } from '@aasis21/weft-shared';
import { Composer } from '@/ui/composer/Composer';

const speechInput = { supported: true, listening: false, error: null as string | null, start: vi.fn(), stop: vi.fn() };
const speechOutput = { supported: true, speaking: false, enqueue: vi.fn(), flush: vi.fn(), cancel: vi.fn() };

vi.mock('@/ui/hooks/useSpeechInput', () => ({ useSpeechInput: () => speechInput }));
vi.mock('@/ui/hooks/useSpeechOutput', () => ({ useSpeechOutput: () => speechOutput }));

function renderComposer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  const defaults: ComponentProps<typeof Composer> = {
    sessionId: 'session-vox',
    disabled: false,
    busy: false,
    mode: 'interactive' as SessionMode,
    cwd: null,
    onPrompt: vi.fn(),
    onInterrupt: vi.fn(),
    onModeChange: vi.fn(),
    onCommand: vi.fn(),
    onOpenVoiceMode: vi.fn(),
  };
  return { ...render(<Composer {...defaults} {...props} />), props: { ...defaults, ...props } };
}

function voxProps(overrides: Partial<NonNullable<ComponentProps<typeof Composer>['vox']>> = {}) {
  return {
    open: false,
    latestAssistant: null,
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onExpand: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Composer Vox mode', () => {
  it('without vox wiring the waveform still opens the full-page overlay (legacy path)', () => {
    const onOpenVoiceMode = vi.fn();
    const { getByLabelText } = renderComposer({ onOpenVoiceMode });
    fireEvent.click(getByLabelText('Open Vox'));
    expect(onOpenVoiceMode).toHaveBeenCalledTimes(1);
  });

  it('with vox wiring the waveform opens the inline dock instead of the overlay', () => {
    const onOpenVoiceMode = vi.fn();
    const vox = voxProps();
    const { getByLabelText } = renderComposer({ onOpenVoiceMode, vox });
    fireEvent.click(getByLabelText('Open Vox'));
    expect(vox.onOpen).toHaveBeenCalledTimes(1);
    expect(onOpenVoiceMode).not.toHaveBeenCalled();
  });

  it('replaces the text box and typing controls with the orb while open', () => {
    const { container, queryByLabelText } = renderComposer({ vox: voxProps({ open: true }) });
    expect(container.querySelector('.composer-input')).toBeNull();
    expect(container.querySelector('.vox-dock')).not.toBeNull();
    expect(queryByLabelText('Attach image')).toBeNull();
    expect(queryByLabelText('Start dictation')).toBeNull();
    expect(queryByLabelText('Switch to typing')).not.toBeNull();
  });

  it('keeps stop-generating reachable while the agent is working', () => {
    const { getByLabelText } = renderComposer({ busy: true, vox: voxProps({ open: true }) });
    expect(getByLabelText('Stop generating')).toBeTruthy();
  });

  it('switches back to typing via the keyboard button', () => {
    const vox = voxProps({ open: true });
    const { getByLabelText } = renderComposer({ vox });
    fireEvent.click(getByLabelText('Switch to typing'));
    expect(vox.onClose).toHaveBeenCalledTimes(1);
  });

  it('carries the heard words into the text box when the caption is tapped', () => {
    const vox = voxProps({ open: true });
    const { container, rerender } = renderComposer({ vox });
    const onText = speechInput.start.mock.calls.at(-1)?.[0] as ((t: string, f: boolean) => void) | undefined;
    act(() => onText?.('rename the branch', false));
    const heard = container.querySelector('button.vox-heard') as HTMLButtonElement;
    fireEvent.click(heard);
    expect(vox.onClose).toHaveBeenCalled();

    rerender(
      <Composer
        sessionId="session-vox"
        disabled={false}
        busy={false}
        mode={'interactive' as SessionMode}
        cwd={null}
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onModeChange={vi.fn()}
        onCommand={vi.fn()}
        onOpenVoiceMode={vi.fn()}
        vox={{ ...vox, open: false }}
      />,
    );
    expect((container.querySelector('.composer-input') as HTMLTextAreaElement).value).toBe('rename the branch');
  });
});
