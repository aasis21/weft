// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { SecureChannel, generateKeyPair, deriveSessionKey, decryptJSON } from "@aasis21/weft-shared";
import { createTerminalHost, validateTerminalRequest, TERMINAL_LIMITS } from "../src/terminalHost.mjs";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");
const waitFor = async (predicate, timeout = 2000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) assert.fail("Timed out waiting for terminal lifecycle.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function harness(t, { terminalClass = Terminal, ...overrides } = {}) {
  const messages = [], localMessages = [], writes = [], writeTimes = [], sizes = [], lifecycle = [];
  const events = new EventEmitter();
  let launches = 0, spawns = 0, kills = 0, socket;
  const child = new EventEmitter();
  child.exitCode = null;
  const pty = {
    write: (data) => { writes.push(data); writeTimes.push(performance.now()); }, resize: (...size) => sizes.push(size),
    pause() {}, resume() {}, kill() { kills++; },
    onData(fn) { events.on("data", fn); return { dispose: () => events.off("data", fn) }; },
    onExit(fn) { events.on("exit", fn); return { dispose: () => events.off("exit", fn) }; },
  };
  const host = createTerminalHost({
    allowTerminal: true,
    projectsApi: { listProjects: () => [{ name: "default", path: process.cwd(), default: true }] },
    loadRuntime: async () => ({ Terminal: terminalClass, SerializeAddon, shell: "managed-shell", pty: { spawn() { spawns++; return pty; } } }),
    launchVisible: ({ pipe, token, terminalId }) => {
      launches++;
      socket = connect(pipe);
      socket.on("error", () => {});
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          localMessages.push(JSON.parse(buffer.slice(0, newline)));
          buffer = buffer.slice(newline + 1);
        }
      });
      socket.on("connect", () => socket.write(`${JSON.stringify({ type: "hello", token, terminalId })}\n`));
      return child;
    },
    send: async (message) => { messages.push(message); },
    lifecycle: (message) => lifecycle.push(message),
    ...overrides,
  });
  t.after(async () => { await host.stop(); socket?.destroy(); });
  const request = (action, fields = {}) => host.handle({
    requestId: `req-${messages.length}`, action, ...(action === "open" ? {} : { terminalId: host.terminalId }), ...fields,
  });
  return {
    host, request, messages, localMessages, writes, writeTimes, sizes, lifecycle, events,
    local: (message) => socket.write(`${JSON.stringify(message)}\n`),
    localClose: () => socket.destroy(),
    get launches() { return launches; }, get spawns() { return spawns; }, get kills() { return kills; },
  };
}

test("terminal authorization and runtime support fail closed without spawning", async (t) => {
  for (const overrides of [{ allowTerminal: false }, { loadRuntime: async () => { throw new Error("Runtime unavailable."); } }]) {
    const h = harness(t, overrides);
    await h.request("open");
    assert.equal(h.spawns, 0);
    assert.equal(h.launches, 0);
    assert.equal(h.host.supported, false);
    assert.equal(h.messages.at(-1).msg.status, "error");
  }
});

test("terminal requests reject unknown fields, malformed generation, input and geometry", () => {
  for (const request of [
    { action: "execute" }, { action: "open", executable: "other" }, { action: "open", cwd: "other" },
    { action: "attach", terminalId: "old" }, { action: "open", cols: 19, rows: 24 },
    { action: "open", cols: 80 }, { action: "open", rows: 100000, cols: 80 },
    { action: "input", terminalId: "12345678-1234-4234-8234-123456789012", inputSeq: 1, data: "a".repeat(TERMINAL_LIMITS.inputBytes + 1) },
  ]) assert.throws(() => validateTerminalRequest({ requestId: "valid", ...request }));
  assert.throws(() => validateTerminalRequest({ requestId: "x".repeat(129), action: "open" }));
});

test("concurrent open owns one shell/window; attach and phone detach never replay commands", async (t) => {
  const h = harness(t);
  await Promise.all([h.request("open"), h.request("open"), h.request("open")]);
  const id = h.host.terminalId;
  assert.ok(id);
  assert.equal(h.spawns, 1);
  assert.equal(h.launches, 1);
  assert.equal(h.messages.at(-1).eventSubtype, "terminal_snapshot");
  assert.equal(h.messages.find((message) => message.eventSubtype === "terminal_state" && message.msg.status === "open").msg.cwd, process.cwd());
  await h.request("input", { inputSeq: 1, data: "first\r" });
  await h.request("detach");
  assert.equal(h.host.terminalId, id);
  h.events.emit("data", "retained screen\r\n");
  await h.request("attach");
  assert.match(h.messages.at(-1).msg.data, /retained screen/);
  assert.equal(h.writes.length, 1);
  assert.equal(h.kills, 0);
  await h.request("open");
  assert.equal(h.host.terminalId, id);
  assert.equal(h.spawns, 1);
});

test("phone duplicate/gap defenses and laptop control reject competing input", async (t) => {
  const h = harness(t);
  await h.request("open");
  await h.request("input", { inputSeq: 1, data: "once\r" });
  await h.request("input", { inputSeq: 1, data: "must not execute\r" });
  await h.request("input", { inputSeq: 3, data: "gap\r" });
  assert.match(h.messages.at(-1).msg.error, /sequence gap/);
  assert.deepEqual(h.writes, ["once\r"]);
  h.local({ type: "input", data: "local", claim: true, cols: 100, rows: 30 });
  await waitFor(() => h.writes.length === 2);
  assert.equal(h.messages.at(-1).msg.owner, "laptop");
  assert.deepEqual(h.sizes.at(-1), [100, 30]);
  await h.request("input", { inputSeq: 2, data: "blocked" });
  assert.match(h.messages.at(-1).msg.error, /Laptop owns/);
  await h.request("claim", { cols: 90, rows: 25 });
  await h.request("input", { inputSeq: 2, data: "phone" });
  assert.deepEqual(h.writes, ["once\r", "local", "phone"]);
  assert.equal(h.messages.at(-1).msg.nextInputSeq, 3);
  h.local({ type: "input", data: "\x1b[0n", claim: false });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.writes.length, 3);
});

test("explicit close changes generation and stale input cannot reach the replacement", async (t) => {
  const h = harness(t);
  await h.request("open");
  const oldId = h.host.terminalId;
  await h.request("close");
  assert.equal(h.host.terminalId, null);
  assert.equal(h.kills, 1);
  await h.request("close", { terminalId: oldId });
  assert.equal(h.messages.at(-1).msg.status, "closed");
  assert.equal(h.kills, 1);
  await h.request("open");
  assert.notEqual(h.host.terminalId, oldId);
  await h.request("input", { terminalId: oldId, data: "stale", inputSeq: 1 });
  assert.match(h.messages.at(-1).msg.error, /ended or been replaced/);
  assert.equal(h.writes.length, 0);
});

test("local window loss and natural shell exit close the owned terminal", async (t) => {
  for (const exit of ["window", "shell"]) {
    const h = harness(t);
    await h.request("open");
    if (exit === "window") h.localClose();
    else h.events.emit("exit", { exitCode: 0 });
    await waitFor(() => h.host.terminalId === null);
    assert.equal(h.kills, 1);
    assert.equal(h.messages.at(-1).msg.status, "closed");
  }
});

test("snapshot boundaries are sequenced and terminal bodies never enter lifecycle diagnostics", async (t) => {
  const h = harness(t);
  await h.request("open");
  h.events.emit("data", "\x1b[31mPRIVATE_OUTPUT\x1b[0m\r\n");
  await h.request("attach");
  const snapshot = h.messages.at(-1).msg;
  const chunks = h.messages.filter((message) => message.eventSubtype === "terminal_output");
  assert.equal(chunks.at(-1).msg.seq, snapshot.seq);
  assert.match(snapshot.data, /PRIVATE_OUTPUT/);
  await h.request("input", { inputSeq: 1, data: "PRIVATE_COMMAND\r" });
  assert.doesNotMatch(JSON.stringify(h.lifecycle), /PRIVATE_OUTPUT|PRIVATE_COMMAND/);
  h.host.disconnectPhone();
  const count = h.messages.length;
  h.events.emit("data", "offline");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.messages.length, count);
  assert.ok(h.host.terminalId);
});

test("non-default projects and visible launch failures never leave a hidden shell", async (t) => {
  const rejected = harness(t);
  await rejected.request("open", { projectName: "unregistered" });
  assert.equal(rejected.spawns, 0);
  const failed = harness(t, { launchVisible() { throw new Error("PRIVATE_NATIVE_PATH"); } });
  await failed.request("open");
  assert.equal(failed.kills, 1);
  assert.equal(failed.host.terminalId, null);
  assert.equal(failed.messages.at(-1).msg.status, "error");
  assert.doesNotMatch(JSON.stringify(failed.messages), /PRIVATE_NATIVE_PATH/);
});

test("unauthenticated pipes cannot attach or claim the terminal", async (t) => {
  let rejected = false;
  const h = harness(t, {
    attachTimeoutMs: 80,
    launchVisible({ pipe, terminalId }) {
      const attacker = connect(pipe);
      attacker.on("error", () => {});
      attacker.on("close", () => { rejected = true; });
      attacker.on("connect", () => attacker.write(`${JSON.stringify({ type: "hello", terminalId, token: "x".repeat(64) })}\n`));
      const child = new EventEmitter();
      child.exitCode = null;
      return child;
    },
  });
  await h.request("open");
  assert.ok(rejected);
  assert.equal(h.host.terminalId, null);
  assert.equal(h.kills, 1);
  assert.equal(h.writes.length, 0);
});

test("discarded blank-line scrollback is explicitly marked truncated", async (t) => {
  const h = harness(t);
  await h.request("open");
  h.events.emit("data", "\r\n".repeat(1000));
  await h.request("attach");
  assert.equal(h.messages.at(-1).msg.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(h.messages.at(-1))) <= TERMINAL_LIMITS.snapshotBytes);
});

test("output flood ends the generation rather than retaining an unbounded buffer", async (t) => {
  const h = harness(t);
  await h.request("open");
  h.events.emit("data", "x".repeat(TERMINAL_LIMITS.pendingChars + 1));
  await waitFor(() => h.host.terminalId === null);
  assert.match(h.messages.at(-1).msg.error, /safety buffer/);
  assert.equal(h.kills, 1);
});

test("a stalled phone delivery does not deadlock Station shutdown", async (t) => {
  const h = harness(t, { send: () => new Promise(() => {}), sendTimeoutMs: 20 });
  await h.request("open");
  assert.ok(h.host.terminalId);
  await h.host.stop();
  assert.equal(h.host.terminalId, null);
  assert.ok(h.lifecycle.some((message) => message.event === "phone_delivery_failed"));
});

test("snapshot trims scrollback and encrypted broadcast stays below the Free relay limit", async (t) => {
  const h = harness(t);
  await h.request("open", { cols: 80, rows: 24 });
  const line = "\x1b[31mX\x1b[32mY".repeat(40) + "\r\n";
  h.events.emit("data", line.repeat(300) + "\x1b[0mSCREEN_TAIL");
  await h.request("attach");
  const snapshot = h.messages.at(-1);
  assert.equal(snapshot.eventSubtype, "terminal_snapshot");
  assert.equal(snapshot.msg.truncated, true);
  assert.match(snapshot.msg.data, /SCREEN_TAIL/);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 128 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 64 * 1024, "Exercise a substantial escaped snapshot, not an empty-screen proxy.");
  assert.equal(TERMINAL_LIMITS.snapshotBytes, 128 * 1024);

  const laptop = await generateKeyPair();
  const phone = await generateKeyPair();
  const key = await deriveSessionKey(laptop.privateKey, phone.publicKeyB64);
  let sealed, wire;
  const channel = new SecureChannel({
    key,
    identity: { channelId: "a".repeat(128), senderId: "weft-listener", senderName: "s".repeat(1024) },
    transport: {
      async publish(event, payload) {
        sealed = payload;
        wire = JSON.stringify({
          topic: `realtime:private:weft:${"a".repeat(128)}`, event: "broadcast",
          payload: { type: "broadcast", event, payload }, ref: "1234567890",
        });
      },
    },
  });
  await channel.send(snapshot);
  assert.ok(Buffer.byteLength(wire) < 256_000, "AES/base64 plus broadcast framing must fit the relay, not only plaintext.");
  assert.equal((await decryptJSON(key, sealed)).message.msg.data, snapshot.msg.data);
  t.diagnostic(`Escaped snapshot: ${Buffer.byteLength(JSON.stringify(snapshot))} bytes; encrypted broadcast: ${Buffer.byteLength(wire)} bytes.`);
});

test("oversized current screen returns explicit errors without cutting VT or leaving attach pending", async (t) => {
  const h = harness(t);
  await h.request("open", { cols: 240, rows: 100 });
  const line = "\x1b[31mX\x1b[32mY".repeat(120) + "\r\n";
  h.events.emit("data", line.repeat(100));
  const before = h.messages.length;
  await h.request("attach");
  const replies = h.messages.slice(before);
  assert.equal(replies.some((message) => message.eventSubtype === "terminal_snapshot"), false);
  const errors = replies.filter((message) => message.eventSubtype === "terminal_state" && message.msg.status === "error");
  assert.ok(errors.some((message) => message.msg.requestId !== null));
  assert.ok(errors.some((message) => message.msg.requestId === null));
  assert.match(errors.at(-1).msg.error, /relay snapshot limit/);
  assert.ok(h.host.terminalId, "The owner can shrink or explicitly close the existing terminal.");
  await h.request("close");
  assert.equal(h.host.terminalId, null);
});

test("immediate shell exit drains final accepted output before closed on both frontends", async (t) => {
  const h = harness(t);
  await h.request("open");
  h.events.emit("data", "final result");
  h.events.emit("exit", { exitCode: 0 });
  h.events.emit("data", "not accepted after exit");
  await waitFor(() => h.host.terminalId === null);
  await waitFor(() => h.localMessages.some((message) => message.msg.status === "closed"));
  for (const messages of [h.messages, h.localMessages]) {
    const output = messages.filter((message) => message.eventSubtype === "terminal_output");
    assert.equal(output.map((message) => message.msg.data).join(""), "final result");
    assert.deepEqual(output.map((message) => message.msg.seq), [1]);
    const closed = messages.findIndex((message) => message.msg.status === "closed");
    assert.ok(messages.indexOf(output.at(-1)) < closed);
  }
});

test("close drains in-flight and queued screen writes and rejects new input", async (t) => {
  let writesStarted = 0;
  class DelayedTerminal extends Terminal {
    write(data, callback) {
      writesStarted++;
      setTimeout(() => super.write(data, callback), 20);
    }
  }
  const h = harness(t, { terminalClass: DelayedTerminal });
  await h.request("open");
  const terminalId = h.host.terminalId;
  const first = "a".repeat(32768);
  h.events.emit("data", first);
  await waitFor(() => writesStarted > 0);
  h.events.emit("data", "queued final result");
  h.events.emit("exit", { exitCode: 0 });
  h.local({ type: "input", data: "must not run locally", claim: true, cols: 80, rows: 24 });
  await h.request("input", { terminalId, inputSeq: 1, data: "must not run" });
  await waitFor(() => h.host.terminalId === null);
  const output = h.messages.filter((message) => message.eventSubtype === "terminal_output");
  assert.equal(output.map((message) => message.msg.data).join(""), first + "queued final result");
  assert.deepEqual(output.map((message) => message.msg.seq), output.map((_, index) => index + 1));
  assert.ok(h.messages.indexOf(output.at(-1)) < h.messages.findIndex((message) => message.msg.status === "closed"));
  assert.deepEqual(h.writes, []);
});

test("final output still drains locally and shutdown stays bounded when the relay hangs", async (t) => {
  let unavailable = false;
  const h = harness(t, {
    sendTimeoutMs: 30, drainTimeoutMs: 30,
    send: () => unavailable ? new Promise(() => {}) : Promise.resolve(),
  });
  await h.request("open");
  unavailable = true;
  h.events.emit("data", "last offline result");
  h.events.emit("exit", { exitCode: 0 });
  await waitFor(() => h.host.terminalId === null, 500);
  await waitFor(() => h.localMessages.some((message) => message.msg.status === "closed"));
  assert.equal(h.localMessages.filter((message) => message.eventSubtype === "terminal_output").map((message) => message.msg.data).join(""), "last offline result");
  assert.ok(h.lifecycle.some((message) => message.event === "phone_delivery_failed"));
});

test("a stalled headless write cannot hang shutdown or publish output after closed", async (t) => {
  let completeWrite;
  class StalledTerminal extends Terminal {
    write(_data, callback) { completeWrite = callback; }
  }
  const h = harness(t, { terminalClass: StalledTerminal, drainTimeoutMs: 30, sendTimeoutMs: 30 });
  await h.request("open");
  h.events.emit("data", "private final output");
  h.events.emit("exit", { exitCode: 0 });
  await waitFor(() => h.host.terminalId === null, 500);
  const closed = h.messages.find((message) => message.msg.status === "closed");
  assert.match(closed.msg.error, /could not be drained/);
  const count = h.messages.length;
  completeWrite();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.messages.length, count);
  assert.doesNotMatch(JSON.stringify(h.lifecycle), /private final output/);
});

test("five local keys precede a 150ms relay acknowledgement and notify only changed state", async (t) => {
  let slow = false;
  const notifications = [], ackTimes = [];
  const h = harness(t, {
    send: async (message) => {
      if (!slow) return;
      notifications.push(message);
      await new Promise((resolve) => setTimeout(resolve, 150));
      ackTimes.push(performance.now());
    },
  });
  await h.request("open");
  slow = true;
  for (const data of "abcde") h.local({ type: "input", data, claim: true, cols: 100, rows: 30 });
  await waitFor(() => h.writes.length === 5);
  await waitFor(() => ackTimes.length > 0);
  assert.deepEqual(h.writes, [..."abcde"]);
  assert.ok(h.writeTimes.every((time) => time < ackTimes[0]), "Every keystroke must reach the PTY before the first relay ACK.");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].msg.owner, "laptop");
  assert.deepEqual(h.sizes, [[100, 30]]);
  h.local({ type: "resize", cols: 100, rows: 30 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(notifications.length, 1);
  h.local({ type: "resize", cols: 110, rows: 30 });
  await waitFor(() => notifications.length === 2);
  assert.equal(notifications[1].msg.cols, 110);
});

test("local keyboard bypasses a phone request already waiting on its relay acknowledgement", async (t) => {
  let slow = false, acknowledged = false;
  const h = harness(t, {
    send: async () => {
      if (slow) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        acknowledged = true;
      }
    },
  });
  await h.request("open");
  slow = true;
  const phoneRequest = h.request("input", { inputSeq: 1, data: "phone" });
  await waitFor(() => h.writes.length === 1);
  h.local({ type: "input", data: "laptop", claim: true, cols: 80, rows: 24 });
  await waitFor(() => h.writes.length === 2);
  assert.equal(acknowledged, false);
  assert.deepEqual(h.writes, ["phone", "laptop"]);
  await phoneRequest;
});

test("failed relay notifications do not disable subsequent local keyboard input", async (t) => {
  let unavailable = false;
  const h = harness(t, {
    sendTimeoutMs: 20,
    send: () => unavailable ? Promise.reject(new Error("private transport failure")) : Promise.resolve(),
  });
  await h.request("open");
  unavailable = true;
  h.local({ type: "input", data: "first", claim: true, cols: 80, rows: 24 });
  await waitFor(() => h.lifecycle.some((message) => message.event === "phone_delivery_failed"));
  h.local({ type: "input", data: "second", claim: true, cols: 80, rows: 24 });
  await waitFor(() => h.writes.length === 2);
  assert.deepEqual(h.writes, ["first", "second"]);
  assert.doesNotMatch(JSON.stringify(h.lifecycle), /private transport failure/);
});

test("CJK and supplementary Unicode output obeys the 16KiB UTF-8 limit without broken codepoints", async (t) => {
  for (const data of ["\u754c".repeat(8192), "a".repeat(16383) + "\u{1f680}".repeat(8192)]) {
    const h = harness(t);
    await h.request("open");
    h.events.emit("data", data);
    await h.request("attach");
    const output = h.messages.filter((message) => message.eventSubtype === "terminal_output");
    assert.ok(output.length > 1);
    assert.equal(output.map((message) => message.msg.data).join(""), data);
    assert.deepEqual(output.map((message) => message.msg.seq), output.map((_, index) => index + 1));
    for (const message of output) {
      assert.ok(Buffer.byteLength(message.msg.data, "utf8") <= 16384);
      assert.equal(Buffer.from(message.msg.data, "utf8").toString("utf8"), message.msg.data);
    }
  }
});

test("surrogate pairs split across PTY callbacks remain one output codepoint", async (t) => {
  const h = harness(t);
  await h.request("open");
  h.events.emit("data", "before \ud83d");
  await h.request("attach");
  h.events.emit("data", "\ude80 after");
  h.events.emit("exit", { exitCode: 0 });
  await waitFor(() => h.host.terminalId === null);
  const output = h.messages.filter((message) => message.eventSubtype === "terminal_output");
  assert.equal(output.map((message) => message.msg.data).join(""), "before \u{1f680} after");
  for (const message of output) assert.equal(Buffer.from(message.msg.data).toString("utf8"), message.msg.data);
});
