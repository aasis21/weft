import type { PhoneCommand, PhoneCommandOption } from '@aasis21/weft-shared';

export interface CommandArgumentStage {
  command: PhoneCommand;
  query: string;
}

export interface CommandArgumentSuggestion {
  key: string;
  label: string;
  hint: string;
  input: string;
  disabled?: boolean;
}

export function getCommandArgumentStage(value: string, command: PhoneCommand | null): CommandArgumentStage | null {
  if (!command || command.input.kind === 'none') return null;
  const match = value.match(/^\/[a-z][a-z-]*\s([\s\S]*)$/i);
  if (!match) return null;
  return { command, query: match[1] ?? '' };
}

export function filterCommandOptions(
  options: ReadonlyArray<PhoneCommandOption>,
  query: string,
): ReadonlyArray<PhoneCommandOption> {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return options;
  return options.filter((option) =>
    [option.label, option.hint ?? '', ...(option.aliases ?? [])].some((candidate) =>
      candidate.toLocaleLowerCase().includes(normalized),
    ),
  );
}

export function getCommandArgumentSuggestions(
  command: PhoneCommand,
  query: string,
): CommandArgumentSuggestion[] {
  if (command.input.kind === 'none') return [];
  const trimmed = query.trim();
  if (command.input.kind === 'text') {
    return [{
      key: 'text',
      label: trimmed ? `Use “${trimmed}”` : command.input.placeholder,
      hint: command.input.required ? 'Required text' : 'Optional text',
      input: trimmed,
      disabled: command.input.required && !trimmed,
    }];
  }

  const suggestions = filterCommandOptions(command.input.options, query).map((option) => ({
    key: option.value,
    label: option.label,
    hint: option.hint ?? `Use ${option.label}`,
    input: option.value,
  }));
  if (command.input.allowCustom && trimmed) {
    suggestions.push({
      key: `custom:${trimmed}`,
      label: `Use “${trimmed}”`,
      hint: 'Custom value',
      input: trimmed,
    });
  }
  return suggestions;
}
