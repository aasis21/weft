import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { PromptAttachment, SessionMode } from '@aasis21/helm-shared';
import { Composer } from '@/ui/composer/Composer';

const mockAttachment: PromptAttachment = {
  data: 'ZmFrZS1qcGVn',
  mimeType: 'image/jpeg',
  name: 'picked.jpg',
};

const { fileToAttachment } = vi.hoisted(() => ({
  fileToAttachment: vi.fn<(file: File) => Promise<PromptAttachment>>(),
}));

const speechState = vi.hoisted(() => ({
  supported: false,
  listening: false,
  error: null as string | null,
  start: vi.fn<(onText: (text: string, isFinal: boolean) => void) => void>(),
  stop: vi.fn<() => void>(),
}));

vi.mock('@/lib/imageAttachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/imageAttachments')>();
  return {
    ...actual,
    fileToAttachment,
  };
});

vi.mock('@/ui/hooks/useSpeechInput', () => ({
  useSpeechInput: () => speechState,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderComposer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  const defaults: ComponentProps<typeof Composer> = {
    sessionId: 'session-a',
    disabled: false,
    busy: false,
    mode: 'interactive' as SessionMode,
    cwd: 'C:\\Users\\akash\\helm',
    onPrompt: vi.fn(),
    onInterrupt: vi.fn(),
    onModeChange: vi.fn(),
  };
  return {
    ...render(<Composer {...defaults} {...props} />),
    props: { ...defaults, ...props },
  };
}

describe('Composer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    fileToAttachment.mockResolvedValue(mockAttachment);
    speechState.supported = false;
    speechState.listening = false;
    speechState.error = null;
  });

  it('renders the textbox above the action row controls', () => {
    const { container } = renderComposer();

    expect(screen.getByRole('textbox', { name: 'Message your Copilot session' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Attach image' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Interactive' })).toHaveClass('mode-pill');
    expect(screen.getByText('📁 helm')).toHaveClass('cwd-chip');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(container.querySelector('.composer-controls')).toBeInTheDocument();
  });

  it('shows distinct disabled placeholder copy for ended and reconnecting sessions', () => {
    const { rerender, props } = renderComposer({ disabled: true, disabledReason: 'ended' });
    expect(screen.getByRole('textbox', { name: 'Message your Copilot session' })).toHaveAttribute(
      'placeholder',
      'Session ended — re-pair to continue.',
    );

    rerender(<Composer {...props} disabled disabledReason="offline" />);
    expect(screen.getByRole('textbox', { name: 'Message your Copilot session' })).toHaveAttribute(
      'placeholder',
      'Reconnecting… — hold on',
    );

    rerender(<Composer {...props} disabled={false} disabledReason={undefined} />);
    expect(screen.getByRole('textbox', { name: 'Message your Copilot session' })).toHaveAttribute(
      'placeholder',
      'Message your Copilot session…',
    );
  });

  it('sends typed text from the button and Ctrl+Enter, but not empty text or plain Enter', async () => {
    const user = userEvent.setup();
    const onPrompt = vi.fn();
    renderComposer({ onPrompt });
    const textbox = screen.getByRole('textbox', { name: 'Message your Copilot session' });

    await user.type(textbox, 'hello helm');
    fireEvent.keyDown(textbox, { key: 'Enter' });
    expect(onPrompt).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onPrompt).toHaveBeenCalledWith('hello helm', undefined);
    expect(textbox).toHaveValue('');

    await user.type(textbox, 'hardware shortcut');
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    expect(onPrompt).toHaveBeenLastCalledWith('hardware shortcut', undefined);

    await user.clear(textbox);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('shows Stop while busy and does not queue prompts while busy', async () => {
    const user = userEvent.setup();
    const onPrompt = vi.fn();
    const onInterrupt = vi.fn();
    renderComposer({ busy: true, onPrompt, onInterrupt });

    const textbox = screen.getByRole('textbox', { name: 'Message your Copilot session' });
    await user.type(textbox, 'do not send yet');
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();

    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    expect(onPrompt).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Stop generating' }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('converts a picked image into an attachment preview and sends it', async () => {
    const user = userEvent.setup();
    const onPrompt = vi.fn();
    const { container } = renderComposer({ onPrompt });
    const input = container.querySelector<HTMLInputElement>('input[type="file"].composer-file-input');
    expect(input).toBeInTheDocument();

    const file = new File(['fake'], 'picked.png', { type: 'image/png' });
    fireEvent.change(input!, { target: { files: [file] } });

    expect(fileToAttachment).toHaveBeenCalledWith(file);
    expect(await screen.findByRole('img', { name: 'picked.jpg' })).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,ZmFrZS1qcGVn',
    );

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onPrompt).toHaveBeenCalledWith('', [mockAttachment]));
    expect(localStorage.getItem('helm.draft-attachments.v1.session-a')).toBeNull();
  });

  it('keeps the attachment spinner visible until concurrent picks finish', async () => {
    const first = deferred<PromptAttachment>();
    const second = deferred<PromptAttachment>();
    fileToAttachment.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    localStorage.setItem('helm.draft-attachments.v1.session-a', JSON.stringify([mockAttachment]));
    const { container } = renderComposer();
    const input = container.querySelector<HTMLInputElement>('input[type="file"].composer-file-input');

    fireEvent.change(input!, { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    await waitFor(() => expect(container.querySelector('.attachment-loading')).toBeInTheDocument());
    fireEvent.change(input!, { target: { files: [new File(['two'], 'two.png', { type: 'image/png' })] } });

    await act(async () => {
      first.resolve({ ...mockAttachment, name: 'one.jpg' });
      await first.promise;
    });
    await waitFor(() => expect(screen.getByRole('img', { name: 'one.jpg' })).toBeInTheDocument());
    expect(container.querySelector('.attachment-loading')).toBeInTheDocument();

    await act(async () => {
      second.resolve({ ...mockAttachment, name: 'two.jpg' });
      await second.promise;
    });
    await waitFor(() => expect(container.querySelector('.attachment-loading')).not.toBeInTheDocument());
    expect(screen.getByRole('img', { name: 'two.jpg' })).toBeInTheDocument();
  });

  it('offers camera capture separately from choosing from the library', async () => {
    const user = userEvent.setup();
    const { container } = renderComposer();

    await user.click(screen.getByRole('button', { name: 'Attach image' }));
    expect(screen.getByRole('menuitem', { name: /Take Photo/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Choose from Library/ })).toBeInTheDocument();

    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"].composer-file-input'));
    const libraryInput = inputs.find((input) => input.multiple);
    const cameraInput = inputs.find((input) => input.getAttribute('capture') === 'environment');
    expect(libraryInput).toHaveAttribute('accept');
    expect(cameraInput).toHaveAttribute('accept', 'image/*');
    expect(cameraInput?.multiple).toBe(false);

    fireEvent.change(cameraInput!, { target: { files: [new File(['photo'], 'photo.jpg', { type: 'image/jpeg' })] } });
    expect(fileToAttachment).toHaveBeenCalledWith(expect.objectContaining({ name: 'photo.jpg' }));
    expect(await screen.findByRole('img', { name: 'picked.jpg' })).toBeInTheDocument();
  });

  it('does not attach an image picked in a previous session after switching sessions', async () => {
    const pending = deferred<PromptAttachment>();
    fileToAttachment.mockReturnValueOnce(pending.promise);
    const rendered = renderComposer();
    const input = rendered.container.querySelector<HTMLInputElement>('input[type="file"].composer-file-input');
    const file = new File(['fake'], 'picked.png', { type: 'image/png' });

    fireEvent.change(input!, { target: { files: [file] } });
    rendered.rerender(<Composer {...rendered.props} sessionId="session-b" />);
    pending.resolve(mockAttachment);
    await pending.promise;
    await Promise.resolve();

    expect(screen.queryByRole('img', { name: 'picked.jpg' })).not.toBeInTheDocument();
    expect(localStorage.getItem('helm.draft-attachments.v1.session-a')).toBeNull();
    expect(localStorage.getItem('helm.draft-attachments.v1.session-b')).toBeNull();
  });

  it('restores attached images per session', async () => {
    const rendered = renderComposer();
    const input = rendered.container.querySelector<HTMLInputElement>('input[type="file"].composer-file-input');
    const file = new File(['fake'], 'picked.png', { type: 'image/png' });

    fireEvent.change(input!, { target: { files: [file] } });
    expect(await screen.findByRole('img', { name: 'picked.jpg' })).toBeInTheDocument();
    expect(localStorage.getItem('helm.draft-attachments.v1.session-a')).toContain('picked.jpg');

    rendered.rerender(<Composer {...rendered.props} sessionId="session-b" />);
    expect(screen.queryByRole('img', { name: 'picked.jpg' })).not.toBeInTheDocument();

    rendered.rerender(<Composer {...rendered.props} sessionId="session-a" />);
    expect(screen.getByRole('img', { name: 'picked.jpg' })).toBeInTheDocument();
  });

  it('stops and ignores speech input when the session changes', async () => {
    const user = userEvent.setup();
    let onSpeech: ((text: string, isFinal: boolean) => void) | undefined;
    speechState.supported = true;
    speechState.start.mockImplementation((callback) => {
      onSpeech = callback;
      speechState.listening = true;
    });
    const rendered = renderComposer();

    await user.click(screen.getByRole('button', { name: 'Start voice input' }));
    expect(speechState.start).toHaveBeenCalledTimes(1);
    speechState.stop.mockClear();

    rendered.rerender(<Composer {...rendered.props} sessionId="session-b" />);
    expect(speechState.stop).toHaveBeenCalledTimes(1);
    onSpeech?.('wrong session words', true);

    expect(screen.getByRole('textbox', { name: 'Message your Copilot session' })).toHaveValue('');
    expect(localStorage.getItem('helm.draft.v1.session-a')).toBeNull();
    expect(localStorage.getItem('helm.draft.v1.session-b')).toBeNull();
  });

  it('appends fresh speech phrases without duplicating committed text', async () => {
    const user = userEvent.setup();
    let onSpeech: ((text: string, isFinal: boolean) => void) | undefined;
    speechState.supported = true;
    speechState.start.mockImplementation((callback) => {
      onSpeech = callback;
      speechState.listening = true;
    });
    renderComposer();
    const textbox = screen.getByRole('textbox', { name: 'Message your Copilot session' });

    await user.type(textbox, 'draft');
    await user.click(screen.getByRole('button', { name: 'Start voice input' }));
    act(() => onSpeech?.('hello', true));
    expect(textbox).toHaveValue('draft hello');
    act(() => onSpeech?.('world', false));
    expect(textbox).toHaveValue('draft hello world');
    act(() => onSpeech?.('world', true));
    expect(textbox).toHaveValue('draft hello world');
  });

  it('does not send a draft when a stop tap finishes after busy clears', async () => {
    const user = userEvent.setup();
    const onPrompt = vi.fn();
    const onInterrupt = vi.fn();
    const rendered = renderComposer({ busy: true, onPrompt, onInterrupt });
    const textbox = screen.getByRole('textbox', { name: 'Message your Copilot session' });
    await user.type(textbox, 'keep this draft');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Stop generating' }));
    rendered.rerender(<Composer {...rendered.props} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onPrompt).not.toHaveBeenCalled();
    expect(textbox).toHaveValue('keep this draft');
  });
});
