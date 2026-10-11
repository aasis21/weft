import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createLocalTransport, SecureChannel, generateKeyPair, deriveSessionKey, randomChannelId,
  workspaceRequest, WORKSPACE_CAPABILITY, interrupt,
} from "@aasis21/weft-shared";
import { createWorkspaceView } from "../src/workspaceView.mjs";
import { attachRelay } from "../src/relay.mjs";

test("encrypted workspace round trip reads policy-approved snapshots while Stop remains usable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weft-workspace-wire-"));
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
