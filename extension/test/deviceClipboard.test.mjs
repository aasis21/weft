// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CLIPBOARD_MAX_BYTES } from "@aasis21/weft-shared";
import { createDeviceClipboard } from "../src/deviceClipboard.mjs";

function childProcess() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin.end = (input) => { child.input = input; };
  child.kills = 0;
  child.kill = () => { child.kills += 1; };
  return child;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("clipboard writes exact UTF-8 through stdin, never through arguments", async () => {
  const child = childProcess();
  const text = "\uFEFF  私の 🔒 $x; 'quotes'\r\n\r\n";
  const adapter = createDeviceClipboard({
    platform: "win32",
    spawnFn: (file, args, options) => {
      assert.equal(file, "powershell.exe");
      assert.ok(args.includes("-STA"));
      assert.equal(args.join(" ").includes(text), false);
      assert.equal(args.at(-1).includes("GetText"), false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.stdio[2], "ignore");
      return child;
    },
  });
  const pending = adapter.writeText(text);
  await tick();
  assert.deepEqual(child.input, Buffer.from(text, "utf8"));
  child.emit("close", 0);
  assert.deepEqual(await pending, { code: "ok" });
  await adapter.shutdown();
});

test("clipboard reads only explicitly and preserves BOM, whitespace and split UTF-8 bytes", async () => {
  const child = childProcess();
  let spawns = 0;
  const adapter = createDeviceClipboard({ platform: "win32", spawnFn: () => { spawns++; return child; } });
  assert.equal(spawns, 0);
  const pending = adapter.readText();
  await tick();
  const bytes = Buffer.from("\uFEFF  café😀\r\n");
  child.stdout.emit("data", bytes.subarray(0, 12));
  child.stdout.emit("data", bytes.subarray(12));
  child.emit("close", 0);
  assert.deepEqual(await pending, { code: "ok", text: bytes.toString("utf8") });
});

test("clipboard treats an empty clipboard as a successful empty read", async () => {
  const child = childProcess();
  const adapter = createDeviceClipboard({ platform: "win32", spawnFn: () => child });
  const pending = adapter.readText();
  await tick();
  child.emit("close", 0);
  assert.deepEqual(await pending, { code: "ok", text: "" });
});

test("clipboard rejects invalid and oversized writes before spawning", async () => {
  const adapter = createDeviceClipboard({ platform: "win32", spawnFn: () => assert.fail("must not spawn") });
  for (const text of [null, 42, {}, "a\0b"]) {
    assert.deepEqual(await adapter.writeText(text), { code: "invalid-request" });
  }
  assert.deepEqual(await adapter.writeText("😀".repeat(CLIPBOARD_MAX_BYTES / 4 + 1)), { code: "too-large" });
});

test("clipboard accepts exactly 64 KiB and bounds read stdout", async () => {
  const child = childProcess();
  const adapter = createDeviceClipboard({ platform: "win32", spawnFn: () => child });
  const write = adapter.writeText("a".repeat(CLIPBOARD_MAX_BYTES));
  await tick();
  assert.equal(child.input.length, CLIPBOARD_MAX_BYTES);
  child.emit("close", 0);
  assert.deepEqual(await write, { code: "ok" });

  const read = adapter.readText();
  await tick();
  child.stdout.emit("data", Buffer.alloc(CLIPBOARD_MAX_BYTES));
  child.stdout.emit("data", Buffer.from("x"));
  assert.deepEqual(await read, { code: "too-large" });
  assert.equal(child.kills, 1);
  child.emit("close", 0);
});

test("clipboard failures, timeouts, absent text, and shutdown never leak raw errors or partial text", async () => {
  for (const failure of ["error", "stdin", "close", "timeout", "shutdown"]) {
    const child = childProcess();
    const adapter = createDeviceClipboard({ platform: "win32", spawnFn: () => child, timeoutMs: 10 });
    const pending = adapter.readText();
    await tick();
    child.stdout.emit("data", Buffer.from("private clipboard"));
    if (failure === "error") child.emit("error", new Error("private failure"));
    if (failure === "stdin") child.stdin.emit("error", new Error("private failure"));
    if (failure === "close") child.emit("close", 2);
    if (failure === "shutdown") await adapter.shutdown();
    assert.deepEqual(await pending, { code: failure === "timeout" ? "timeout" : "unavailable" });
    child.emit("error", new Error("late private failure"));
    await adapter.shutdown();
    assert.deepEqual(await adapter.readText(), { code: "unavailable" });
  }
});

test("clipboard queues operations and cancels queued writes at shutdown", async () => {
  const child = childProcess();
  let spawns = 0;
  const adapter = createDeviceClipboard({ platform: "win32", spawnFn: () => { spawns++; return child; } });
  const read = adapter.readText();
  const write = adapter.writeText("not written");
  await tick();
  assert.equal(spawns, 1);
  await adapter.shutdown();
  assert.deepEqual(await read, { code: "unavailable" });
  assert.deepEqual(await write, { code: "unavailable" });
  assert.equal(spawns, 1);
});

test("clipboard capability is platform-gated and spawn exceptions are sanitized", async () => {
  const unsupported = createDeviceClipboard({ platform: "linux", spawnFn: () => assert.fail("must not spawn") });
  assert.equal(unsupported.supported, false);
  assert.deepEqual(await unsupported.readText(), { code: "unsupported" });
  assert.deepEqual(await unsupported.writeText("text"), { code: "unsupported" });
  const broken = createDeviceClipboard({ platform: "win32", spawnFn: () => { throw new Error("secret"); } });
  assert.equal(broken.supported, true);
  assert.deepEqual(await broken.readText(), { code: "unavailable" });
});

test("macOS clipboard uses native plain-text APIs and preserves exact UTF-8 through stdin/stdout", async () => {
  const children = [];
  const text = "\uFEFF  café😀 $x; 'quotes'\r\n\r\n";
  const adapter = createDeviceClipboard({
    platform: "darwin",
    spawnFn(file, args, options) {
      assert.equal(options.env.LC_ALL, "en_US.UTF-8");
      assert.equal(options.stdio[2], "ignore");
      assert.equal(args.includes(text), false);
      assert.equal(file, "/usr/bin/osascript");
      assert.deepEqual(args.slice(0, 3), ["-l", "JavaScript", "-e"]);
      assert.match(args[3], /NSPasteboardTypeString/);
      assert.match(args[3], children.length === 0 ? /setDataForType/ : /dataForType/);
      assert.doesNotMatch(args[3], /console\.log/);
      const child = childProcess();
      children.push(child);
      return child;
    },
  });
  assert.equal(adapter.supported, true);
  const write = adapter.writeText(text);
  await tick();
  assert.deepEqual(children[0].input, Buffer.from(text));
  children[0].emit("close", 0);
  assert.deepEqual(await write, { code: "ok" });
  const read = adapter.readText();
  await tick();
  const bytes = Buffer.from(text);
  children[1].stdout.emit("data", bytes.subarray(0, 11));
  children[1].stdout.emit("data", bytes.subarray(11));
  children[1].emit("close", 0);
  assert.deepEqual(await read, { code: "ok", text });
  await adapter.shutdown();
});

test("macOS clipboard bounds output and sanitizes native failures, timeout, and shutdown", async () => {
  for (const mode of ["size", "error", "timeout", "shutdown"]) {
    const child = childProcess();
    const adapter = createDeviceClipboard({ platform: "darwin", spawnFn: () => child, timeoutMs: 20 });
    assert.deepEqual(await adapter.writeText("a\0b"), { code: "invalid-request" });
    assert.deepEqual(await adapter.writeText("x".repeat(CLIPBOARD_MAX_BYTES + 1)), { code: "too-large" });
    const read = adapter.readText();
    await tick();
    if (mode === "size") child.stdout.emit("data", Buffer.alloc(CLIPBOARD_MAX_BYTES + 1));
    if (mode === "error") child.emit("error", new Error("private clipboard"));
    if (mode === "shutdown") await adapter.shutdown();
    assert.deepEqual(await read, { code: mode === "size" ? "too-large" : mode === "timeout" ? "timeout" : "unavailable" });
    assert.equal(child.kills, 1);
    await adapter.shutdown();
  }
});

test("native macOS clipboard round-trips text without losing BOM, Unicode, whitespace, or trailing newlines", {
  skip: process.platform !== "darwin" || process.env.WEFT_NATIVE_MACOS_TEST !== "1",
}, async (t) => {
  const adapter = createDeviceClipboard();
  const original = await adapter.readText();
  assert.equal(original.code, "ok", "Clipboard must be readable before changing it.");
  t.after(async () => {
    assert.equal((await adapter.writeText(original.text)).code, "ok");
    await adapter.shutdown();
  });
  const text = "\uFEFF  café😀 $x; 'quotes'\r\n\r\n";
  assert.equal((await adapter.writeText(text)).code, "ok");
  assert.deepEqual(await adapter.readText(), { code: "ok", text });
  assert.equal((await adapter.writeText("")).code, "ok");
  assert.deepEqual(await adapter.readText(), { code: "ok", text: "" });
});
