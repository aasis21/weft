// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachTerminal, isTerminalReply, localTerminalDimensions } from "../src/terminalClient.mjs";
import { parseStartOptions } from "../src/startOptions.mjs";

test("full shell grant is explicit and default start remains unchanged", () => {
  assert.equal(parseStartOptions().allowTerminal, undefined);
  assert.equal(parseStartOptions(["--allow-terminal"]).allowTerminal, true);
  assert.throws(() => parseStartOptions(["--allow-termina"]));
});

test("visible terminal dimensions are bounded", () => {
  assert.deepEqual(localTerminalDimensions({ columns: 5000, rows: 10000 }), { cols: 240, rows: 100 });
  assert.deepEqual(localTerminalDimensions({ columns: 1, rows: 1 }), { cols: 20, rows: 5 });
});

test("terminal query responses do not masquerade as keyboard control claims", () => {
  for (const response of ["\x1b[0n", "\x1b[12;30R", "\x1b[?1;2c", "\x1b[>0;10;1c", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\"]) {
    assert.equal(isTerminalReply(response), true);
  }
  for (const keyboard of ["hello", "\r", "\x03", "\x1b[A", "\x1b", "\t"]) assert.equal(isTerminalReply(keyboard), false);
});

test("manual attach requires private handoff and clears credentials before failure", async () => {
  const env = { WEFT_TERMINAL_PIPE: "wrong", WEFT_TERMINAL_TOKEN: "PRIVATE", WEFT_TERMINAL_ID: "wrong" };
  await assert.rejects(attachTerminal({ env, openConsole: false }), /private Station handoff/);
  assert.deepEqual(env, {});
});
