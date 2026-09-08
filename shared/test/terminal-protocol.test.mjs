import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEVICE_CAPABILITY, EVENT_TYPE, SUBTYPE,
  terminalRequest, terminalState, terminalOutput, terminalSnapshot, isValidEnvelope,
} from "../messages.mjs";

test("terminal support is negotiated independently of device monitoring", () => {
  assert.equal(DEVICE_CAPABILITY.TERMINAL_V1, "device-terminal-v1");
  assert.notEqual(DEVICE_CAPABILITY.TERMINAL_V1, DEVICE_CAPABILITY.MONITOR_V1);
  assert.ok(Object.isFrozen(DEVICE_CAPABILITY));
});

const cases = [
  [terminalRequest, SUBTYPE.CONTROL.TERMINAL_REQUEST, {
    requestId: "request-1", action: "input", terminalId: "terminal-1",
    inputSeq: 1, data: "Write-Output 'hello'\r",
  }],
  [terminalState, SUBTYPE.CONTROL.TERMINAL_STATE, {
    requestId: "request-1", terminalId: "terminal-1", status: "open",
    shell: "PowerShell", cwd: "C:\\Projects\\example", cols: 80, rows: 24,
    owner: "phone", nextInputSeq: 2, error: null,
  }],
  [terminalOutput, SUBTYPE.CONTROL.TERMINAL_OUTPUT, {
    terminalId: "terminal-1", seq: 12, data: "\u001b[32mhello\u001b[0m\r\n",
  }],
  [terminalSnapshot, SUBTYPE.CONTROL.TERMINAL_SNAPSHOT, {
    terminalId: "terminal-1", seq: 12, data: "\u001b[Hhello",
    cols: 80, rows: 24, truncated: true,
  }],
];

for (const [factory, subtype, payload] of cases) {
  test(`${subtype} preserves the payload inside the encrypted envelope`, () => {
    const message = factory(payload);
    assert.equal(message.eventType, EVENT_TYPE.CONTROL);
    assert.equal(message.eventSubtype, subtype);
    assert.deepEqual(message.msg, payload);
    assert.notEqual(message.msg, payload);
    assert.equal(typeof message.ts, "number");
    assert.ok(isValidEnvelope(message));
    assert.equal(message.channelId, undefined);
    assert.equal(message.senderId, undefined);
    assert.equal(message.data, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(message)).msg, payload);
  });
}

test("open and attach remain distinct actions, not implicit command retries", () => {
  const open = terminalRequest({ requestId: "open-1", action: "open", projectName: "example" });
  const attach = terminalRequest({ requestId: "attach-1", action: "attach", terminalId: "terminal-1" });
  assert.equal(open.msg.action, "open");
  assert.equal(attach.msg.action, "attach");
  assert.equal(open.msg.data, undefined);
  assert.equal(attach.msg.data, undefined);
  assert.equal(attach.msg.inputSeq, undefined);
});
