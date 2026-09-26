import { describe, expect, it } from 'vitest';
import type { PhoneCommand } from '@aasis21/weft-shared';
import {
  filterCommandOptions,
  getCommandArgumentStage,
  getCommandArgumentSuggestions,
} from '@/ui/composer/commandPalette';

const optionCommand: PhoneCommand = {
  name: 'target',
  label: '/target',
  hint: 'Choose a target',
  input: {
    kind: 'options',
    required: true,
    allowCustom: true,
    placeholder: 'Choose a target',
    options: [
      { value: 'hidden-one', label: 'Friendly One', hint: 'Recommended', aliases: ['default'] },
      { value: 'hidden-two', label: 'Friendly Two', hint: 'Fast choice', aliases: ['quick'] },
    ],
  },
};

describe('commandPalette', () => {
  it('opens the argument stage only after a command and separator', () => {
    expect(getCommandArgumentStage('/target', optionCommand)).toBeNull();
    expect(getCommandArgumentStage('/target ', optionCommand)).toEqual({
      command: optionCommand,
      query: '',
    });
  });

  it('filters options by friendly labels, hints, and aliases without requiring internal values', () => {
    if (optionCommand.input.kind !== 'options') throw new Error('test definition must use options');
    expect(filterCommandOptions(optionCommand.input.options, 'friendly two').map((option) => option.value))
      .toEqual(['hidden-two']);
    expect(filterCommandOptions(optionCommand.input.options, 'recommended').map((option) => option.value))
      .toEqual(['hidden-one']);
    expect(filterCommandOptions(optionCommand.input.options, 'quick').map((option) => option.value))
      .toEqual(['hidden-two']);
  });

  it('offers custom input only when the option definition allows it', () => {
    if (optionCommand.input.kind !== 'options') throw new Error('test definition must use options');
    expect(getCommandArgumentSuggestions(optionCommand, 'other').at(-1)).toMatchObject({
      label: 'Use “other”',
      hint: 'Custom value',
      input: 'other',
    });

    const curatedOnly: PhoneCommand = {
      ...optionCommand,
      input: { ...optionCommand.input, allowCustom: false },
    };
    expect(getCommandArgumentSuggestions(curatedOnly, 'other')).toEqual([]);
  });

  it('represents required and optional text through the same argument stage', () => {
    const required: PhoneCommand = {
      name: 'rename',
      label: '/rename',
      hint: 'Rename',
      input: { kind: 'text', required: true, placeholder: 'Session name' },
    };
    expect(getCommandArgumentSuggestions(required, '')[0]).toMatchObject({
      label: 'Session name',
      disabled: true,
    });
    expect(getCommandArgumentSuggestions(required, 'My Session')[0]).toMatchObject({
      label: 'Use “My Session”',
      input: 'My Session',
      disabled: false,
    });
  });
});
