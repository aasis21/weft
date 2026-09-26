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
 * @typedef {Object} PhoneCommandOption
 * @property {string}                   value    Internal CLI value; never used as visible copy.
 * @property {string}                   label    Friendly value shown in the phone palette.
 * @property {string}                   [hint]   Optional supporting copy shown under the label.
 * @property {ReadonlyArray<string>}    [aliases] Friendly search and input aliases.
 *
 * @typedef {{ kind: "none" }} PhoneCommandNoInput
 * @typedef {{ kind: "text", required: boolean, placeholder: string }} PhoneCommandTextInput
 * @typedef {{ kind: "options", required: boolean, allowCustom: boolean, placeholder: string, options: ReadonlyArray<PhoneCommandOption> }} PhoneCommandOptionsInput
 * @typedef {PhoneCommandNoInput | PhoneCommandTextInput | PhoneCommandOptionsInput} PhoneCommandInput
 *
 * @typedef {Object} PhoneCommand
 * @property {string}          name     Canonical command name (no leading slash), lower-case.
 * @property {string}          label    Short human label for the palette.
 * @property {string}          hint     One-line description shown under the label.
 * @property {PhoneCommandInput} input  Argument experience and validation rules.
 * @property {boolean}         [confirm] Require an explicit phone confirmation before running
 *                                       (destructive / permission-broadening commands).
 */

const noInput = Object.freeze({ kind: "none" });

function textInput(required, placeholder) {
  return Object.freeze({ kind: "text", required, placeholder });
}

function optionsInput(required, allowCustom, placeholder, options) {
  return Object.freeze({
    kind: "options",
    required,
    allowCustom,
    placeholder,
    options: Object.freeze(
      options.map((option) =>
        Object.freeze({
          ...option,
          ...(option.aliases ? { aliases: Object.freeze([...option.aliases]) } : {}),
        }),
      ),
    ),
  });
}

/** @type {ReadonlyArray<PhoneCommand>} */
export const PHONE_COMMANDS = Object.freeze(
  [
    // --- Tier 1: safe, fire-and-return, meaningful when driving from a phone ---
    { name: "rename", label: "/rename", hint: "Rename this session", input: textInput(true, "Session name") },
    { name: "compact", label: "/compact", hint: "Summarize context to free space", input: textInput(false, "Optional focus") },
    {
      name: "model",
      label: "/model",
      hint: "Switch the model for this session",
      input: optionsInput(true, false, "Choose a model", [
        { value: "auto", label: "Auto", hint: "Recommended", aliases: ["recommended", "default"] },
        { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", aliases: ["gpt", "sol"] },
        { value: "claude-sonnet-5", label: "Claude Sonnet 5", aliases: ["claude", "sonnet"] },
        { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", aliases: ["gemini", "flash"] },
      ]),
    },
    { name: "autopilot", label: "/autopilot", hint: "Toggle autopilot mode", input: textInput(false, "Optional instructions") },
    { name: "plan", label: "/plan", hint: "Enter plan mode", input: noInput },
    { name: "review", label: "/review", hint: "Review the current changes", input: noInput },
    { name: "security-review", label: "/security-review", hint: "Security-review the changes", input: noInput },
    { name: "rubber-duck", label: "/rubber-duck", hint: "Independent critique of the work", input: noInput },
    { name: "keep-alive", label: "/keep-alive", hint: "Keep the laptop awake", input: textInput(false, "Optional duration") },
    // --- Tier 2: allowed but require an explicit confirm on the phone ---
    { name: "allow-all", label: "/allow-all", hint: "Allow all tools, paths & URLs", input: noInput, confirm: true },
    { name: "clear", label: "/clear", hint: "Abandon this session, start fresh", input: noInput, confirm: true },
  ].map((command) => Object.freeze(command)),
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

function normalizeOptionLookup(raw) {
  return typeof raw === "string" ? raw.trim().toLocaleLowerCase() : "";
}

/**
 * Resolve a curated option by internal value, friendly label, or alias.
 * @param {PhoneCommand | string} commandOrName
 * @param {unknown} raw
 * @returns {PhoneCommandOption | null}
 */
export function getPhoneCommandOption(commandOrName, raw) {
  const command =
    typeof commandOrName === "string" ? getPhoneCommand(commandOrName) : commandOrName;
  if (!command || command.input.kind !== "options") return null;
  const lookup = normalizeOptionLookup(raw);
  if (!lookup) return null;
  return (
    command.input.options.find((option) =>
      [option.value, option.label, ...(option.aliases ?? [])].some(
        (candidate) => candidate.toLocaleLowerCase() === lookup,
      ),
    ) ?? null
  );
}

/**
 * Validate and canonicalize a phone-command argument.
 * @param {PhoneCommand | string} commandOrName
 * @param {unknown} raw
 * @returns {{ valid: true, input?: string, option?: PhoneCommandOption } | { valid: false, error: string }}
 */
export function validatePhoneCommandInput(commandOrName, raw) {
  const command =
    typeof commandOrName === "string" ? getPhoneCommand(commandOrName) : commandOrName;
  if (!command) return { valid: false, error: "Command is not allowed from the phone." };

  const input = typeof raw === "string" ? raw.trim() : "";
  if (command.input.kind === "none") {
    return input
      ? { valid: false, error: `/${command.name} does not accept an argument.` }
      : { valid: true };
  }

  if (!input) {
    return command.input.required
      ? { valid: false, error: `/${command.name} needs an argument.` }
      : { valid: true };
  }

  if (command.input.kind === "text") return { valid: true, input };

  const option = getPhoneCommandOption(command, input);
  if (option) return { valid: true, input: option.value, option };
  if (command.input.allowCustom) return { valid: true, input };
  return { valid: false, error: `That value isn't available for /${command.name}.` };
}
