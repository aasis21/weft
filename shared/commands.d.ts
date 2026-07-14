// SPDX-License-Identifier: Apache-2.0
// Types for the phone-invokable Copilot CLI slash-command whitelist. See commands.mjs.

export type PhoneCommandArg = "none" | "optional" | "required";

export interface PhoneCommand {
  /** Canonical command name (no leading slash), lower-case. */
  name: string;
  /** Short human label for the palette (includes the leading slash). */
  label: string;
  /** One-line description shown under the label. */
  hint: string;
  /** Whether the command takes free-text input after the name. */
  arg: PhoneCommandArg;
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
