// Unit tests for the phone-command whitelist (shared/commands.mjs) and the invokeCommand factory.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PHONE_COMMANDS,
  normalizeCommandName,
  getPhoneCommand,
  isPhoneCommandAllowed,
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
    assert.ok(["none", "optional", "required"].includes(c.arg));
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
