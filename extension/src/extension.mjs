import QRCode from "qrcode";
import { joinSession } from "@github/copilot-sdk/extension";
import {
  SecureChannel,
  createLocalTransport,
  createSupabaseTransport,
  generateKeyPair,
  randomChannelId,
  buildPairingPayload,
  waitForPeer,
} from "@aasis21/helm-shared";
import { attachRelay, createPermissionRelay } from "./relay.mjs";

const laptopKeys = await generateKeyPair();
const channelId = process.env.HELM_CHANNEL_ID || randomChannelId();
const pairingPayload = buildPairingPayload({
  channelId,
  publicKeyB64: laptopKeys.publicKeyB64,
});

let relayHandle = null;
let permissionRelay = null;
const transport = createTransport({ channelId });

const session = await joinSession({
  streaming: true,
  onPermissionRequest: async (request, invocation) => {
    if (!permissionRelay) {
      return {
        kind: "denied-by-permission-request-hook",
        message: "Helm encrypted approval relay is not connected",
        interrupt: false,
      };
    }
    return permissionRelay.onPermissionRequest(request, invocation);
  },
  commands: [
    {
      name: "helm-pair",
      description: "Show the Helm mobile pairing QR code for this Copilot session.",
      handler: async () => {
        await logPairingQr(session, JSON.stringify(pairingPayload));
      },
    },
  ],
  hooks: {
    onSessionEnd: async (input) => {
      await relayHandle?.stop?.(input?.reason ?? "session_end");
      return { cleanupActions: ["Stopped Helm relay"] };
    },
  },
});

await logPairingQr(session, JSON.stringify(pairingPayload));
session.log?.("Helm: waiting for phone pairing hello…");

try {
  const { key, peer } = await waitForPeer({
    transport,
    keyPair: laptopKeys,
    timeoutMs: 0,
  });
  const channel = new SecureChannel({
    transport,
    key,
    identity: {
      userId: process.env.HELM_USER_ID || "copilot",
      deviceId: process.env.HELM_DEVICE_ID || "laptop",
      sessionId: session.sessionId || channelId,
    },
  });
  permissionRelay = createPermissionRelay({
    channel,
    logger: (message, options) => session.log?.(message, options),
  });
  // TODO(p4): Supabase subscribe ordering. waitForPeer connects before SecureChannel
  // handlers are registered; LocalTransport supports this, but Supabase Broadcast may
  // require order-independent subscribe semantics in the transport implementation.
  relayHandle = await attachRelay({
    session,
    channel,
    channelId,
    permissionRelay,
  });
  relayHandle.session = session;
  session.log?.(
    `Helm: encrypted relay attached to ${peer.deviceId ?? "phone"}.`,
  );
} catch (err) {
  process.stderr.write(`Helm: encrypted channel not ready: ${err?.message ?? err}\n`);
  session.log?.(
    `Helm: encrypted relay could not attach: ${err?.message ?? err}`,
    { level: "warning", ephemeral: false },
  );
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void relayHandle?.stop?.(sig).finally(() => process.exit(0));
  });
}

async function logPairingQr(session, payload) {
  const qr = await QRCode.toString(payload, { type: "terminal", small: true });
  session.log?.(`Helm pairing payload:\n${qr}\n${payload}`, {
    level: "info",
    ephemeral: false,
  });
}

function createTransport({ channelId }) {
  const transportName = process.env.HELM_TRANSPORT || "local";
  if (transportName === "local") return createLocalTransport({ channelId });

  // TODO(phase2): construct the real Supabase client here once relay transport
  // ownership lands. Keep secrets in env vars; never embed credentials in code.
  return createSupabaseTransport({
    client: null,
    channelId,
  });
}
