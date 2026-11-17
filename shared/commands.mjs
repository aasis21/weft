// SPDX-License-Identifier: Apache-2.0
// Weft — slash commands offered in the phone composer. Two kinds:
//   - PHONE_COMMANDS: the whitelist of Copilot CLI slash commands the phone may run on the laptop
//     session (CONTROL.INVOKE_COMMAND -> session.rpc.commands.invoke on the extension side).
//   - SESSION_CONTROL_COMMANDS: mode, model and reasoning effort, which Weft changes itself through
//     the session RPC (CONTROL.MODE, CONTROL.MODEL_SET). They are never sent as CLI commands.
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

// ---- Session controls ---------------------------------------------------------------------------

/** Reasoning effort values as people read them. Unknown values are shown as sent. */
export const REASONING_EFFORT_LABELS = Object.freeze({
  none: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max",
});

export function describeReasoningEffort(value) {
  return REASONING_EFFORT_LABELS[value] ?? String(value ?? "");
}

/** Shown only until the laptop reports the models this account can actually use. */
export const FALLBACK_MODEL_OPTIONS = Object.freeze(
  [
    { value: "auto", label: "Auto", hint: "Recommended", aliases: ["recommended", "default"] },
    { value: "claude-opus-5.5", label: "Claude Opus 5.5", aliases: ["opus"] },
    { value: "claude-sonnet-5", label: "Claude Sonnet 5", aliases: ["claude", "sonnet"] },
    { value: "gpt-6.1-sol", label: "GPT-6.1 Sol", aliases: ["gpt", "sol"] },
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", aliases: ["gemini", "flash"] },
  ].map((option) => Object.freeze({ ...option, ...(option.aliases ? { aliases: Object.freeze(option.aliases) } : {}) })),
);

const FALLBACK_EFFORT_OPTIONS = ["low", "medium", "high", "xhigh"]
  .map((value) => ({ value, label: describeReasoningEffort(value) }));

/** @type {ReadonlyArray<PhoneCommand>} */
export const SESSION_CONTROL_COMMANDS = Object.freeze(
  [
    { name: "interactive", label: "/interactive", hint: "Interactive mode: asks before acting", input: noInput },
    { name: "plan", label: "/plan", hint: "Plan mode: agree a plan before changes", input: noInput },
    { name: "autopilot", label: "/autopilot", hint: "Autopilot mode: keeps working without asking", input: noInput },
    {
      name: "model",
      label: "/model",
      hint: "Switch the model for this session",
      input: optionsInput(true, false, "Choose a model", FALLBACK_MODEL_OPTIONS),
    },
    {
      name: "effort",
      label: "/effort",
      hint: "Set how hard the model thinks",
      input: optionsInput(true, false, "Choose an effort level", FALLBACK_EFFORT_OPTIONS),
    },
  ].map((command) => Object.freeze(command)),
);

/** Look up a session control command (mode, model, effort) by name; null if it is not one. */
export function getSessionControlCommand(name) {
  const canonical = normalizeCommandName(name);
  if (!canonical) return null;
  return SESSION_CONTROL_COMMANDS.find((c) => c.name === canonical) ?? null;
}

/** The same command with its options replaced, for example by the laptop's live model list. */
export function withCommandOptions(command, options) {
  if (!command || command.input.kind !== "options" || !Array.isArray(options) || options.length === 0) return command;
  return Object.freeze({
    ...command,
    input: optionsInput(command.input.required, command.input.allowCustom, command.input.placeholder, options),
  });
}
