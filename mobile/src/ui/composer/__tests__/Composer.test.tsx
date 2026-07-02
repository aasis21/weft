import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

vi.mock('@/lib/imageAttachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/imageAttachments')>();
  return {
    ...actual,
    fileToAttachment,
  };
});

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
    fileToAttachment.mockResolvedValue(mockAttachment);
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
  });
});
