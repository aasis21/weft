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

test("getPhoneCommand resolves whitelisted names case/slash-insensitively", () => {
  assert.equal(getPhoneCommand("/MODEL")?.name, "model");
  assert.equal(getPhoneCommand("rename")?.name, "rename");
  assert.equal(getPhoneCommand("resume"), null);
  assert.equal(getPhoneCommand(""), null);
});

test("isPhoneCommandAllowed gates non-whitelisted commands", () => {
  assert.equal(isPhoneCommandAllowed("clear"), true);
  assert.equal(isPhoneCommandAllowed("/plan"), true);
  assert.equal(isPhoneCommandAllowed("resume"), false);
  assert.equal(isPhoneCommandAllowed("settings"), false);
});

test("confirm-gated commands are marked and destructive", () => {
  assert.equal(getPhoneCommand("clear")?.confirm, true);
  assert.equal(getPhoneCommand("allow-all")?.confirm, true);
  assert.equal(getPhoneCommand("plan")?.confirm, undefined);
});

test("model exposes curated friendly options with hidden canonical values", () => {
  const model = getPhoneCommand("model");
  assert.equal(model?.input.kind, "options");
  assert.deepEqual(
    model.input.options.map(({ value, label, hint }) => ({ value, label, hint })),
    [
      { value: "auto", label: "Auto", hint: "Recommended" },
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", hint: undefined },
      { value: "claude-sonnet-5", label: "Claude Sonnet 5", hint: undefined },
      { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", hint: undefined },
    ],
  );
});

test("option lookup accepts values, friendly labels, and aliases", () => {
  assert.equal(getPhoneCommandOption("model", "GPT-5.6 Sol")?.value, "gpt-5.6-sol");
  assert.equal(getPhoneCommandOption("model", "recommended")?.value, "auto");
  assert.equal(getPhoneCommandOption("model", "claude-sonnet-5")?.label, "Claude Sonnet 5");
  assert.equal(getPhoneCommandOption("rename", "anything"), null);
});

test("input validation preserves text/no-input behavior and canonicalizes options", () => {
  assert.deepEqual(validatePhoneCommandInput("plan", ""), { valid: true });
  assert.deepEqual(validatePhoneCommandInput("plan", "extra"), {
    valid: false,
    error: "/plan does not accept an argument.",
  });
  assert.deepEqual(validatePhoneCommandInput("rename", "  My Session  "), {
    valid: true,
    input: "My Session",
  });
  assert.deepEqual(validatePhoneCommandInput("rename", ""), {
    valid: false,
    error: "/rename needs an argument.",
  });

  const model = validatePhoneCommandInput("model", "Sonnet");
  assert.equal(model.valid, true);
  assert.equal(model.input, "claude-sonnet-5");
  assert.equal(model.option?.label, "Claude Sonnet 5");
  assert.deepEqual(validatePhoneCommandInput("model", "unlisted-model"), {
    valid: false,
    error: "That value isn't available for /model.",
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
