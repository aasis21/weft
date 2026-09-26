// SPDX-License-Identifier: Apache-2.0
// Types for the phone-invokable Copilot CLI slash-command whitelist. See commands.mjs.

export interface PhoneCommandOption {
  /** Internal CLI value; never use as visible UI copy. */
  value: string;
  /** Friendly value shown in the phone palette. */
  label: string;
  /** Optional supporting copy shown under the label. */
  hint?: string;
  /** Friendly search and input aliases. */
  aliases?: ReadonlyArray<string>;
}

export type PhoneCommandInput =
  | { kind: "none" }
  | { kind: "text"; required: boolean; placeholder: string }
  | {
      kind: "options";
      required: boolean;
      allowCustom: boolean;
      placeholder: string;
      options: ReadonlyArray<PhoneCommandOption>;
    };

export interface PhoneCommand {
  /** Canonical command name (no leading slash), lower-case. */
  name: string;
  /** Short human label for the palette (includes the leading slash). */
  label: string;
  /** One-line description shown under the label. */
  hint: string;
  /** Argument experience and validation rules. */
  input: PhoneCommandInput;
  /** Require an explicit phone confirmation before running (destructive / permission-broadening). */
  confirm?: boolean;
}

/** The frozen whitelist of slash commands the phone may invoke on the laptop session. */
export const PHONE_COMMANDS: ReadonlyArray<PhoneCommand>;

/** Normalize free-form input ("/Rename", " rename ") to a canonical command name. */
export function normalizeCommandName(raw: string): string;

/** Look up a whitelisted phone command by name (leading slash + case ignored); null if not allowed. */
export function getPhoneCommand(name: string): PhoneCommand | null;

/** True iff `name` is a command the phone is allowed to invoke. */
export function isPhoneCommandAllowed(name: string): boolean;

/** Resolve a curated option by internal value, friendly label, or alias. */
export function getPhoneCommandOption(
  commandOrName: PhoneCommand | string,
  raw: unknown,
): PhoneCommandOption | null;

/** Validate and canonicalize a phone-command argument. */
export function validatePhoneCommandInput(
  commandOrName: PhoneCommand | string,
  raw: unknown,
):
  | { valid: true; input?: string; option?: PhoneCommandOption }
  | { valid: false; error: string };
