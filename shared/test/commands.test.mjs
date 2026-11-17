// Unit tests for the phone-command whitelist (shared/commands.mjs) and the invokeCommand factory.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PHONE_COMMANDS,
  normalizeCommandName,
  getPhoneCommand,
  getPhoneCommandOption,
  isPhoneCommandAllowed,
  validatePhoneCommandInput,
  SESSION_CONTROL_COMMANDS,
  getSessionControlCommand,
  withCommandOptions,
  describeReasoningEffort,
} from "../commands.mjs";
import { EVENT_TYPE, SUBTYPE, invokeCommand } from "../messages.mjs";

test("PHONE_COMMANDS is a frozen, non-empty list with well-formed entries", () => {
  assert.ok(Object.isFrozen(PHONE_COMMANDS));
  assert.ok(PHONE_COMMANDS.length > 0);
  for (const c of PHONE_COMMANDS) {
    assert.equal(typeof c.name, "string");
    assert.ok(c.name.length > 0);
    assert.equal(c.name, c.name.toLowerCase());
    assert.doesNotMatch(c.name, /^\//); // no leading slash in canonical name
    assert.equal(c.label, `/${c.name}`);
    assert.ok(["none", "text", "options"].includes(c.input.kind));
    assert.ok(Object.isFrozen(c.input));
    if (c.input.kind === "options") {
      assert.ok(Object.isFrozen(c.input.options));
      assert.ok(c.input.options.every((option) => Object.isFrozen(option)));
    }
    assert.ok(Object.isFrozen(c));
  }
});

test("normalizeCommandName strips slashes/whitespace and lowercases", () => {
  assert.equal(normalizeCommandName("/Rename"), "rename");
  assert.equal(normalizeCommandName("  //model "), "model");
  assert.equal(normalizeCommandName("SECURITY-REVIEW"), "security-review");
  assert.equal(normalizeCommandName(""), "");
  assert.equal(normalizeCommandName(null), "");
});

test("getPhoneCommand resolves whitelisted CLI commands case/slash-insensitively", () => {
  assert.equal(getPhoneCommand("/RENAME")?.name, "rename");
  assert.equal(getPhoneCommand("compact")?.name, "compact");
  assert.equal(getPhoneCommand("resume"), null);
  assert.equal(getPhoneCommand(""), null);
});

test("mode, model and effort are session controls, never laptop CLI commands", () => {
  for (const name of ["interactive", "plan", "autopilot", "model", "effort"]) {
    assert.equal(isPhoneCommandAllowed(name), false, `${name} is not sent as a CLI command`);
    assert.equal(getSessionControlCommand(`/${name.toUpperCase()}`)?.name, name);
  }
  assert.equal(isPhoneCommandAllowed("clear"), true);
  assert.equal(isPhoneCommandAllowed("resume"), false);
  assert.equal(getSessionControlCommand("rename"), null);
  assert.ok(Object.isFrozen(SESSION_CONTROL_COMMANDS));
});

test("confirm-gated commands are marked and destructive", () => {
  assert.equal(getPhoneCommand("clear")?.confirm, true);
  assert.equal(getPhoneCommand("allow-all")?.confirm, true);
  assert.equal(getPhoneCommand("review")?.confirm, undefined);
});

test("the fallback model list includes Opus and GPT-6.1 Sol, and live options replace it", () => {
  const model = getSessionControlCommand("model");
  assert.deepEqual(model.input.options.map((option) => option.value),
    ["auto", "claude-opus-5.5", "claude-sonnet-5", "gpt-6.1-sol", "gpt-5.6-sol", "gemini-3.8-flash"]);
  assert.equal(validatePhoneCommandInput(model, "opus").input, "claude-opus-5.5");
  assert.equal(getPhoneCommandOption(model, "recommended")?.value, "auto");
  const live = withCommandOptions(model, [{ value: "gpt-6.1-sol", label: "GPT-6.1 Sol" }]);
  assert.equal(validatePhoneCommandInput(live, "GPT-6.1 Sol").input, "gpt-6.1-sol");
  assert.deepEqual(validatePhoneCommandInput(live, "claude-opus-5.5"), {
    valid: false, error: "That value isn't available for /model.",
  });
  assert.equal(withCommandOptions(model, []), model, "an empty live list keeps the fallback");
});

test("reasoning effort values read naturally", () => {
  assert.equal(describeReasoningEffort("xhigh"), "Extra high");
  assert.equal(describeReasoningEffort("medium"), "Medium");
  assert.equal(describeReasoningEffort("turbo"), "turbo");
  assert.equal(validatePhoneCommandInput(getSessionControlCommand("effort"), "Extra high").input, "xhigh");
});

test("input validation preserves text/no-input behavior", () => {
  assert.deepEqual(validatePhoneCommandInput("review", ""), { valid: true });
  assert.deepEqual(validatePhoneCommandInput("review", "extra"), {
    valid: false,
    error: "/review does not accept an argument.",
  });
  assert.deepEqual(validatePhoneCommandInput("rename", "  My Session  "), {
    valid: true,
    input: "My Session",
  });
  assert.deepEqual(validatePhoneCommandInput("rename", ""), {
    valid: false,
    error: "/rename needs an argument.",
  });
});
test("option validation supports custom values only when the definition allows them", () => {
  const customCommand = {
    name: "custom",
    label: "/custom",
    hint: "Custom option command",
    input: {
      kind: "options",
      required: true,
      allowCustom: true,
      placeholder: "Choose or type",
      options: [{ value: "known", label: "Known" }],
    },
  };
  assert.deepEqual(validatePhoneCommandInput(customCommand, "other"), {
    valid: true,
    input: "other",
  });
});

test("invokeCommand builds a CONTROL/INVOKE_COMMAND envelope, omitting empty input", () => {
  const bare = invokeCommand("plan");
  assert.equal(bare.eventType, EVENT_TYPE.CONTROL);
  assert.equal(bare.eventSubtype, SUBTYPE.CONTROL.INVOKE_COMMAND);
  assert.equal(bare.msg.name, "plan");
  assert.ok(!("input" in bare.msg));

  const withInput = invokeCommand("rename", "My Session");
  assert.equal(withInput.msg.name, "rename");
  assert.equal(withInput.msg.input, "My Session");
});
