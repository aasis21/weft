import { useState } from 'react';

interface PromptComposerProps {
  disabled: boolean;
  onPrompt(text: string): Promise<void>;
}

export function PromptComposer({ disabled, onPrompt }: PromptComposerProps): JSX.Element {
  const [text, setText] = useState('');

  const send = async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText('');
    await onPrompt(trimmed);
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <input
        aria-label="Prompt"
        disabled={disabled}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Type a prompt into the live session…"
      />
      <button className="primary-action compact" type="submit" disabled={disabled || !text.trim()}>
        Send
      </button>
    </form>
  );
}
