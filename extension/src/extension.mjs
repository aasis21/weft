// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import QRCode from "qrcode";
import { createClient } from "@supabase/supabase-js";
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

// Best-effort: load SUPABASE_URL / SUPABASE_ANON_KEY / HELM_TRANSPORT from a colocated
// `.env` (next to the installed extension or in the launch cwd) so operators don't have to
// export them by hand before every `gh copilot`. Already-exported shell vars always win;
// a missing/unreadable file is a silent no-op. Never commit a real `.env` (it is gitignored).
function loadLocalEnv() {
  if (typeof parseEnv !== "function") return;
  const here = (() => {
    try {
      return dirname(fileURLToPath(import.meta.url));
    } catch {
      return null;
    }
  })();
  const candidates = [join(process.cwd(), ".env")];
  if (here) candidates.push(join(here, ".env"));
  for (const file of candidates) {
    try {
      const parsed = parseEnv(readFileSync(file, "utf8"));
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
      return;
    } catch {
      // No readable .env here; try the next candidate.
    }
  }
}
loadLocalEnv();

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
});

// Session-end cleanup. The native runtime (Copilot CLI >= 1.0.66) no longer accepts
// SDK callback hooks (the old `hooks: { onSessionEnd }` throws at session.resume), so we
// subscribe to the `session.shutdown` event instead to stop the relay and tell the phone.
session.on?.("session.shutdown", (event) => {
  const reason = event?.data?.shutdownType ?? event?.data?.errorReason ?? "session_end";
  void relayHandle?.stop?.(reason);
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
  // SupabaseTransport is subscribe-order independent (single catch-all broadcast listener
  // + internal dispatch), so attachRelay may register SecureChannel handlers after
  // waitForPeer has connected without losing events on either transport.
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

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Helm: HELM_TRANSPORT=supabase requires SUPABASE_URL and SUPABASE_ANON_KEY",
    );
  }
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Helm uses *private* broadcast channels, authorized by RLS on realtime.messages
  // (see supabase/migrations). The anon key is the realtime access token; without
  // setAuth + the RLS policies applied, channel joins are denied.
  client.realtime.setAuth(anonKey);
  return createSupabaseTransport({ client, channelId });
}
