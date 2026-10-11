import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createLocalTransport, SecureChannel, generateKeyPair, deriveSessionKey, randomChannelId,
  workspaceRequest, WORKSPACE_CAPABILITY, SESSION_FILES_CAPABILITY, interrupt, stateRequest,
} from "@aasis21/weft-shared";
import { createWorkspaceView } from "../src/workspaceView.mjs";
import { attachRelay } from "../src/relay.mjs";

test("encrypted workspace round trip reads policy-approved snapshots while Stop remains usable", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "weft-workspace-wire-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "report.md"), "# Private synthetic report\n");
  const channelId = randomChannelId(), laptop = await generateKeyPair(), phone = await generateKeyPair();
  const laptopTransport = createLocalTransport({ channelId }), phoneTransport = createLocalTransport({ channelId });
  const wire = [];
  laptopTransport.subscribe("control", (value) => wire.push(value));
  const hostChannel = new SecureChannel({
    transport: laptopTransport, key: await deriveSessionKey(laptop.privateKey, phone.publicKeyB64),
    identity: { channelId, sessionId: "synthetic-workspace-session" },
  });

  const phoneChannel = new SecureChannel({
    transport: phoneTransport, key: await deriveSessionKey(phone.privateKey, laptop.publicKeyB64),
    identity: { channelId },
  });
  await phoneChannel.connect();
  const received = [];
  phoneChannel.onEvent("control", (value) => received.push(value));
  let approvals = 0, aborts = 0, view;
  const session = {
    sessionId: "synthetic-workspace-session", cwd: root, on: () => () => {}, log() {},
    rpc: {
      eventLog: { read: async () => ({ cursorStatus: "ok", cursor: "tail", hasMore: false, events: [
        { type: "tool.execution_complete", data: { toolCallId: "report", success: true,
          fileEdits: [{ path: join(root, "report.md"), kind: "create" }] } },
      ] }) },
      abort: async () => { aborts++; },
      permissions: { paths: {
        list: async () => ({ primary: root }),
        isPathWithinAllowedDirectories: async () => ({ allowed: true }),
      } },
      contentExclusion: { checkPaths: async ({ paths }) => ({ available: true,
        checks: paths.map((path) => ({ path, excluded: false })) }) },
      tools: { execute: async ({ name, arguments: args }) => {
        assert.equal(name, "weft_workspace_access"); approvals++;
        return view.grant(args);
      } },
    },
  };
  view = await createWorkspaceView({ session, requestPermission: (args) =>
    session.rpc.tools.execute({ name: "weft_workspace_access", arguments: args }) });
  const relay = await attachRelay({ session, channel: hostChannel, channelId, heartbeatMs: 100000,
    workspaceView: async () => view });
  t.after(async () => { view.close(); await relay.stop(); await phoneChannel.close(); });
  async function response(id) {
    for (let n = 0; n < 200; n++) {
      const result = received.find((message) => message.eventSubtype === "workspace_result" && message.msg.requestId === id);
      if (result) return result.msg;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("No encrypted workspace reply");
  }
  await phoneChannel.send(workspaceRequest({ requestId: "list", action: "list", path: "" }));
  const listing = await response("list");
  assert.equal(listing.data.entries[0].path, "report.md");
  assert.equal(listing.data.text, undefined);
  assert.ok(received.find((message) => message.eventSubtype === "channel_up").msg.capabilities.includes(WORKSPACE_CAPABILITY));
  await phoneChannel.send(workspaceRequest({ requestId: "open", action: "open", path: "report.md" }));
  assert.equal((await response("open")).data.text, "# Private synthetic report\n");
  await phoneChannel.send(interrupt());
  for (let n = 0; n < 100 && !aborts; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aborts, 1);
  assert.equal(approvals, 2);
  assert.doesNotMatch(JSON.stringify(wire), /Private synthetic report|report\.md/);
});

test("workspace capabilities follow real policy readiness and recover without breaking chat controls", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "weft-workspace-policy-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map(), sent = [];
  const channel = {
    connect: async () => {}, close: async () => {},
    send: async (message) => { sent.push(message); },
    onEvent(type, handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(handler);
      return () => handlers.get(type).delete(handler);
    },
  };
  const emit = (message) => {
    for (const handler of handlers.get(message.eventType) ?? []) handler(message);
  };
  let available = false, broken = false, approvals = 0, aborts = 0, view;
  const session = {
    sessionId: "synthetic-workspace-policy", cwd: root, on: () => () => {}, log() {},
    rpc: {
      eventLog: { read: async () => ({ cursorStatus: "ok", cursor: "tail", hasMore: false, events: [] }) },
      abort: async () => { aborts++; },
      permissions: { paths: {
        list: async () => ({ primary: root }),
        isPathWithinAllowedDirectories: async () => ({ allowed: true }),
      } },
      contentExclusion: { checkPaths: async ({ paths }) => {
        if (broken) throw Object.assign(new Error("synthetic-private-host-detail"), { code: "unavailable" });
        return { available: available || paths.length === 0,
          checks: available ? paths.map((path) => ({ path, excluded: false })) : [] };
      } },
      tools: { execute: async ({ arguments: args }) => { approvals++; return view.grant(args); } },
    },
  };
  view = await createWorkspaceView({ session, requestPermission: (args) =>
    session.rpc.tools.execute({ name: "weft_workspace_access", arguments: args }) });
  const relay = await attachRelay({ session, channel, channelId: "synthetic-policy", heartbeatMs: 100000,
    workspaceView: async () => view });
  t.after(async () => { view.close(); await relay.stop(); });
  assert.deepEqual(sent.find((message) => message.eventSubtype === "channel_up").msg.capabilities, []);
  assert.match(sent.find((message) => message.eventSubtype === "log").msg.message, /Restart or update Copilot/);
  assert.equal(approvals, 0);

  async function snapshot() {
    const count = sent.filter((message) => message.eventSubtype === "state_snapshot").length;
    emit(stateRequest());
    for (let n = 0; n < 200; n++) {
      const snapshots = sent.filter((message) => message.eventSubtype === "state_snapshot");
      if (snapshots.length > count) return snapshots.at(-1).msg;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("No workspace capability snapshot");
  }
  await snapshot();
  assert.equal(sent.filter((message) => message.eventSubtype === "log").length, 1);
  available = true;
  assert.deepEqual((await snapshot()).capabilities, [WORKSPACE_CAPABILITY, SESSION_FILES_CAPABILITY]);
  available = false;
  assert.deepEqual((await snapshot()).capabilities, []);
  broken = true;
  assert.deepEqual((await snapshot()).capabilities, []);
  assert.doesNotMatch(JSON.stringify(sent), /synthetic-private-host-detail/);
  emit(interrupt());
  for (let n = 0; n < 100 && !aborts; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aborts, 1);
  assert.equal(approvals, 0);
});
