#!/usr/bin/env node
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  EVENT_TYPE,
  SUBTYPE,
  approvalDecision,
  modeChange,
  prompt,
  generateKeyPair,
  randomChannelId,
  SecureChannel,
  createLocalTransport,
  _resetLocalBus,
  buildPairingPayload,
  parsePairingPayload,
  waitForPeer,
  sayHello,
} from "@aasis21/helm-shared";
import { attachRelay } from "../src/relay.mjs";

const auto = process.argv.includes("--auto");

class FakeSession {
  constructor() {
    this.sessionId = "fake-session-1";
    this.cwd = "C:\\Users\\akash\\helm";
    this.sent = [];
    this.modeSetCalls = [];
    this.logs = [];
    this.events = new EventEmitter();
    this._mode = "interactive";
    this.rpc = {
      mode: {
        set: async ({ mode }) => {
          this.modeSetCalls.push(mode);
          const previousMode = this._mode;
          this._mode = mode;
          this.emitSession("session.mode_changed", { previousMode, newMode: mode });
          return { mode };
        },
        get: async () => ({ mode: this._mode }),
      },
    };
  }

  on(handler) {
    this.events.on("event", handler);
    return () => this.events.off("event", handler);
  }

  emitSession(type, data = {}) {
    this.events.emit("event", {
      id: `${type}-${Date.now()}-${Math.random()}`,
      timestamp: new Date().toISOString(),
      parentId: null,
      type,
      data,
    });
  }

  async send(options) {
    this.sent.push(options);
    return `sent-${this.sent.length}`;
  }

  log(message, options = {}) {
    this.logs.push({ message, options });
  }
}

async function main() {
  _resetLocalBus();
  const channelId = randomChannelId();
  const laptop = await generateKeyPair();
  const phone = await generateKeyPair();
  const laptopTransport = createLocalTransport({ channelId });
  const phoneTransport = createLocalTransport({ channelId });
  const qrPayload = buildPairingPayload({
    channelId,
    publicKeyB64: laptop.publicKeyB64,
  });
  const parsed = parsePairingPayload(qrPayload);

  const laptopPairing = waitForPeer({
    transport: laptopTransport,
    keyPair: laptop,
    channelId,
    timeoutMs: 5_000,
  });
  const phonePairing = await sayHello({
    transport: phoneTransport,
    keyPair: phone,
    peerPublicKeyB64: parsed.publicKeyB64,
    channelId,
    deviceId: "harness-phone",
    senderName: "WebApp",
    waitForAck: true,
  });
  const laptopPairingResult = await laptopPairing;
  assert.equal(laptopPairingResult.peer.publicKeyB64, phone.publicKeyB64);
  assert.equal(laptopPairingResult.peer.deviceId, "harness-phone");

  const extChannel = new SecureChannel({
    transport: laptopTransport,
    key: laptopPairingResult.key,
    identity: { channelId, sessionId: "fake-session-1", senderId: "copilot", senderName: "Copilot" },
  });
  const phoneChannel = new SecureChannel({
    transport: phoneTransport,
    key: phonePairing.key,
    identity: { channelId, sessionId: "fake-session-1", senderId: "harness-phone", senderName: "WebApp" },
  });
  await phoneChannel.connect();

  const session = new FakeSession();
  const seen = {
    channelUp: false,
    assistant: false,
    delta: false,
    toolStart: false,
    toolComplete: false,
    approval: false,
    modeConfirm: false,
    channelDown: false,
  };

  phoneChannel.onEvent(EVENT_TYPE.CONTROL, (msg) => {
    if (msg.eventSubtype === SUBTYPE.CONTROL.CHANNEL_UP) seen.channelUp = true;
    if (msg.eventSubtype === SUBTYPE.CONTROL.MODE && msg.msg.mode === "plan") seen.modeConfirm = true;
    if (msg.eventSubtype === SUBTYPE.CONTROL.CHANNEL_DOWN) seen.channelDown = true;
    print(auto, `[control] ${msg.eventSubtype}`);
  });

  phoneChannel.onEvent(EVENT_TYPE.STREAM, (msg) => {
    if (msg.eventSubtype === SUBTYPE.STREAM.ASSISTANT_MESSAGE) seen.assistant = true;
    if (msg.eventSubtype === SUBTYPE.STREAM.ASSISTANT_DELTA) seen.delta = true;
    if (msg.eventSubtype === SUBTYPE.STREAM.TOOL_START) seen.toolStart = true;
    if (msg.eventSubtype === SUBTYPE.STREAM.TOOL_COMPLETE) seen.toolComplete = true;
    print(auto, `[stream] ${msg.eventSubtype} ${summarize(msg.msg)}`);
  });

  phoneChannel.onEvent(EVENT_TYPE.APPROVAL, async (msg) => {
    if (msg.eventSubtype !== SUBTYPE.APPROVAL.REQUEST) return;
    seen.approval = true;
    print(auto, `[approval] ${msg.msg.toolName} ${JSON.stringify(msg.msg.toolArgs)}`);
    const optionId = auto ? "approved" : await askApproval(msg.msg);
    await phoneChannel.send(approvalDecision(msg.msg.requestId, optionId));
  });

  const relay = await attachRelay({
    session,
    channel: extChannel,
    channelId,
    approvalTimeoutMs: 5_000,
    heartbeatMs: 1_000,
  });

  session.emitSession("assistant.message_delta", {
    messageId: "m1",
    deltaContent: "Hello",
  });
  session.emitSession("assistant.message", {
    messageId: "m1",
    content: "Hello from Helm harness",
  });
  session.emitSession("tool.execution_start", {
    toolCallId: "t1",
    toolName: "powershell",
    arguments: { command: "Write-Output hi" },
  });
  session.emitSession("tool.execution_complete", {
    toolCallId: "t1",
    toolName: "powershell",
    success: true,
    result: { content: "hi" },
  });

  const permission = await relay.onPermissionRequest(
    {
      kind: "shell",
      toolName: "powershell",
      arguments: { command: "Write-Output approved" },
    },
    { sessionId: session.sessionId },
  );

  await phoneChannel.send(prompt("run the Helm smoke test"));
  await phoneChannel.send(modeChange("plan"));
  await waitFor(() => session.sent.some((m) => m.prompt === "run the Helm smoke test"));
  await waitFor(() => session.modeSetCalls.includes("plan"));
  await waitFor(() => seen.modeConfirm);

  await relay.stop("harness_complete");
  await waitFor(() => seen.channelDown);
  await phoneChannel.close();

  assert.equal(permission.kind, "approve-once");
  assert.deepEqual(seen, {
    channelUp: true,
    assistant: true,
    delta: true,
    toolStart: true,
    toolComplete: true,
    approval: true,
    modeConfirm: true,
    channelDown: true,
  });
  assert.equal(session.sent[0].mode, "immediate");
  assert.equal((await session.rpc.mode.get()).mode, "plan");

  console.log("Helm harness smoke passed.");
}

function print(quiet, message) {
  if (!quiet) console.log(message);
}

function summarize(payload) {
  return payload?.content ?? payload?.toolName ?? payload?.message ?? "";
}

async function askApproval(payload) {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Approve ${payload.toolName}? [Y/n] `,
    );
    return answer.trim().toLowerCase().startsWith("n")
      ? "denied-interactively-by-user"
      : "approved";
  } finally {
    rl.close();
  }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for harness condition");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
