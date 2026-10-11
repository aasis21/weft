// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { createSessionFiles } from "../src/sessionFiles.mjs";

const root = resolve("synthetic-session");
const start = (id, toolName, path, extra = {}) => ({ type: "tool.execution_start",
  data: { toolCallId: id, toolName, arguments: { path }, ...extra } });
const complete = (id, success = true, extra = {}) => ({ type: "tool.execution_complete",
  data: { toolCallId: id, success, ...extra } });
function journal(events, batchSize = 500) {
  const calls = [];
  const session = { rpc: { eventLog: { read: async (args) => {
    calls.push(args);
    const offset = Number(args.cursor ?? 0), next = Math.min(events.length, offset + batchSize);
    return { cursorStatus: "ok", events: events.slice(offset, next), cursor: String(next), hasMore: next < events.length };
  } } } };
  return { session, calls };
}

test("records only successful known local file reads and authoritative committed writes", async () => {
  const read = join(root, "read.md"), write = join(root, "write.md"), partial = join(root, "partial.md");
  const events = [
    start("read", "view", read), complete("read"),
    start("write", "edit", write), complete("write", true, { fileEdits: [{ path: write, kind: "edit" }] }),
    start("failed", "view", join(root, "failed.md")), complete("failed", false),
    start("denied", "view", join(root, "denied.md")), complete("denied", true, { error: { message: "denied" } }),
    start("directory", "glob", root), complete("directory"),
    start("shell", "powershell", join(root, "shell.md")), complete("shell"),
    start("mcp", "view", join(root, "remote.md"), { mcpServerName: "remote" }), complete("mcp"),
    start("relative", "view", "relative.md"), complete("relative"),
    start("sandbox", "view", join(root, "sandbox.md")), complete("sandbox", true, { sandboxed: true }),
    complete("partial", false, { fileEdits: [{ path: partial, kind: "create" }] }),
    start("again", "view", write), complete("again"),
  ];
  const { session, calls } = journal(events, 2);
  const files = createSessionFiles({ session });
  await files.sync();
  assert.deepEqual(files.entries().map((file) => file.path), [read, write, partial]);
  assert.deepEqual(files.entries().find((file) => file.path === write), { path: write, read: true, written: true });
  assert.ok(calls.every((call) => call.waitMs === 0 && call.includeEphemeral === false &&
    call.agentScope === "all" && call.types.length === 2));
  assert.equal(files.has(join(root, "failed.md")), false);
});

test("rebuilds from host history on reload and incrementally picks up later external files", async () => {
  const inside = join(root, "read.md"), outside = resolve("other-folder", "outside.md");
  const events = [start("first", "view", inside), complete("first")];
  const { session } = journal(events);
  const files = createSessionFiles({ session });
  await files.sync();
  events.push(complete("second", true, { fileEdits: [{ path: outside, kind: "create" }] }));
  await files.sync();
  assert.equal(files.has(outside), true);
  const reloaded = createSessionFiles({ session });
  await reloaded.sync();
  assert.deepEqual(reloaded.entries(), files.entries());
  const anotherSession = createSessionFiles({ session: journal([]).session });
  await anotherSession.sync();
  assert.equal(anotherSession.has(outside), false);
});

test("expired history revokes previously recorded paths and is rebuilt only from the new journal", async () => {
  const path = join(root, "previous.md");
  const { session } = journal([start("old", "view", path), complete("old")]);
  const files = createSessionFiles({ session });
  await files.sync();
  session.rpc.eventLog.read = async () => ({ cursorStatus: "expired" });
  await assert.rejects(files.sync(), { code: "changed" });
  assert.equal(files.has(path), false);
  session.rpc.eventLog.read = journal([]).session.rpc.eventLog.read;
  await files.sync();
  assert.deepEqual(files.entries(), []);
});

test("unavailable and malformed host history fail explicitly without reconstructing shell arguments", async () => {
  await assert.rejects(createSessionFiles({ session: {} }).sync(), { code: "unsupported" });
  const session = { rpc: { eventLog: { read: async () => { throw new Error("private host detail"); } } } };
  await assert.rejects(createSessionFiles({ session }).sync(), {
    code: "unavailable", message: /session file history could not be read/,
  });
  session.rpc.eventLog.read = async () => ({ events: [], cursor: "same", hasMore: true, cursorStatus: "ok" });
  await assert.rejects(createSessionFiles({ session }).sync(), { code: "unavailable" });
});
