// SPDX-License-Identifier: Apache-2.0
// Weft — whitelist of Copilot CLI slash commands the phone is allowed to invoke on the laptop
// session (via CONTROL.INVOKE_COMMAND -> session.rpc.commands.invoke on the extension side).
//
// SINGLE SOURCE OF TRUTH: the mobile command palette renders from this list, and the extension
// re-validates against it before invoking — so a command can never be run from a phone unless it
// appears here, and the two ends can't drift.
//
// Deliberately excluded (interactive TUI pickers / full-screen views weft sits below, laptop-local
// actions, or things weft already does natively): /resume, /session, /context, /diff, /settings,
// /theme, /ide, /help, /copy, /login, /voice (weft Voice Mode), /new (weft spawn), /pr, /delegate…

/**
 * @typedef {"none" | "optional" | "required"} PhoneCommandArg
 * @typedef {Object} PhoneCommand
 * @property {string}          name     Canonical command name (no leading slash), lower-case.
 * @property {string}          label    Short human label for the palette.
 * @property {string}          hint     One-line description shown under the label.
 * @property {PhoneCommandArg} arg      Whether the command takes free-text input after the name.
 * @property {boolean}         [confirm] Require an explicit phone confirmation before running
 *                                       (destructive / permission-broadening commands).
 */

/** @type {ReadonlyArray<PhoneCommand>} */
export const PHONE_COMMANDS = Object.freeze(
  [
    // --- Tier 1: safe, fire-and-return, meaningful when driving from a phone ---
    { name: "rename", label: "/rename", hint: "Rename this session", arg: "required" },
    { name: "compact", label: "/compact", hint: "Summarize context to free space", arg: "optional" },
    { name: "model", label: "/model", hint: "Switch model (give a model id)", arg: "required" },
    { name: "autopilot", label: "/autopilot", hint: "Toggle autopilot mode", arg: "optional" },
    { name: "plan", label: "/plan", hint: "Enter plan mode", arg: "none" },
    { name: "review", label: "/review", hint: "Review the current changes", arg: "none" },
    { name: "security-review", label: "/security-review", hint: "Security-review the changes", arg: "none" },
    { name: "rubber-duck", label: "/rubber-duck", hint: "Independent critique of the work", arg: "none" },
    { name: "keep-alive", label: "/keep-alive", hint: "Keep the laptop awake", arg: "optional" },
    // --- Tier 2: allowed but require an explicit confirm on the phone ---
    { name: "allow-all", label: "/allow-all", hint: "Allow all tools, paths & URLs", arg: "none", confirm: true },
    { name: "clear", label: "/clear", hint: "Abandon this session, start fresh", arg: "none", confirm: true },
  ].map((c) => Object.freeze(c)),
);

/** Normalize free-form input ("/Rename", " rename ") to a canonical command name. */
export function normalizeCommandName(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/^\/+/, "").toLowerCase();
}

/**
 * Look up a whitelisted phone command by name (leading slash + case ignored).
 * @returns {PhoneCommand | null} the entry, or null when not whitelisted.
 */
export function getPhoneCommand(name) {
  const canonical = normalizeCommandName(name);
  if (!canonical) return null;
  return PHONE_COMMANDS.find((c) => c.name === canonical) ?? null;
}

/** True iff `name` is a command the phone is allowed to invoke. */
export function isPhoneCommandAllowed(name) {
  return getPhoneCommand(name) !== null;
}
