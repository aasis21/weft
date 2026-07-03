// SPDX-License-Identifier: Apache-2.0
import { readFileSync, unlinkSync } from "node:fs";
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
  importKeyPair,
  randomChannelId,
  buildPairingPayload,
  listenForPeers,
} from "@aasis21/helm-shared";
import { attachRelay, createPermissionRelay } from "./relay.mjs";

// Minimal ANSI styling for the pairing banner. The Copilot CLI forwards ANSI straight to the
// terminal (the QR itself is rendered with ANSI escapes), so truecolor brand accents render in
// any modern terminal. Honor NO_COLOR (https://no-color.org) and TERM=dumb — otherwise the
// helpers just return the bare string, so the banner stays readable everywhere.
const HELM_COLOR = !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (codes) => (s) => (HELM_COLOR ? `\x1b[${codes}m${s}\x1b[0m` : `${s}`);
const ui = {
  brand: paint("1;38;2;198;242;78"), // bold signal-lime (#C6F24E) — Helm's primary
  lime: paint("38;2;198;242;78"),
  cyan: paint("38;2;63;224;206"), // secondary accent (#3FE0CE)
  dim: paint("2"),
};

// Best-effort: load SUPABASE_URL / SUPABASE_ANON_KEY / HELM_TRANSPORT from a colocated
// `.env` (next to the installed extension or in the launch cwd) so operators don't have to
// export them by hand before every `copilot`. Already-exported shell vars always win;
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
  // The install-dir .env (next to a shipped extension) is canonical, so it is tried first
  // and its values win; the launch cwd .env is a secondary fallback. Both are merged — we do
  // NOT stop after the first readable file, so a partial cwd/.env can't mask the install one.
  // Any already-exported process env still wins per key (see the collision note in
  // createTransport for why Helm uses HELM_SUPABASE_* rather than generic SUPABASE_*).
  const candidates = [];
  if (here) candidates.push(join(here, ".env"));
  candidates.push(join(process.cwd(), ".env"));
  for (const file of candidates) {
    try {
      const parsed = parseEnv(readFileSync(file, "utf8"));
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
    } catch {
      // No readable .env here; try the next candidate.
    }
  }
}
loadLocalEnv();

const handedOffIdentity = await loadIdentityFromFile(process.env.HELM_IDENTITY_FILE);
const identityFileWasPresent = Boolean(handedOffIdentity);
const laptopKeys = handedOffIdentity?.laptopKeys ?? (await generateKeyPair());
const channelId = handedOffIdentity?.channelId ?? (process.env.HELM_CHANNEL_ID || randomChannelId());
const pairingPayload = buildPairingPayload({
  channelId,
  publicKeyB64: laptopKeys.publicKeyB64,
});

let relayHandle = null;
let permissionRelay = null;
let shuttingDown = false;
let connecting = false;
let reconnecting = false;
// Persistent pairing state. `listenForPeers` keeps the laptop answering phone hellos for the whole
// session (not just the first pair), so re-scans/reloads always re-pair. We dedupe by peer public
// key so a phone re-broadcasting its hello only re-attaches the relay once.
let pairingStop = null;
let activeTransport = null;
let activeStatusStop = null;
let currentPeerPub = null;
let pairChain = Promise.resolve();

// Show the full pairing walk-through (instructions + QR + status) and re-kick the relay listener
// if it isn't currently live (initial connect gave up, or it was torn down). A live listener
// already answers re-scans, so we never stack a second transport. Bound to the `/helm` command.
const showPairing = async () => {
  await logPairing(session, JSON.stringify(pairingPayload), { full: true });
  if (!pairingStop && !shuttingDown) void connectRelayWithRetry();
};

const session = await joinSession({
  streaming: true,
  onPermissionRequest: async (request, invocation) => {
    if (!permissionRelay) {
      // No phone is paired yet, so Helm has no remote user to ask. Report the user as
      // unavailable (a valid native decision kind) so the CLI falls back to its own
      // in-terminal approval prompt instead of erroring on an unknown decision.
      return { kind: "user-not-available" };
    }
    return permissionRelay.onPermissionRequest(request, invocation);
  },
  commands: [
    {
      name: "helm",
      description: "Pair your phone with this Copilot session — shows the QR + setup steps.",
      handler: showPairing,
    },
  ],
});

// Session-end cleanup. The native runtime (Copilot CLI >= 1.0.66) no longer accepts
// SDK callback hooks (the old `hooks: { onSessionEnd }` throws at session.resume), so we
// subscribe to the `session.shutdown` event instead to stop the relay and tell the phone.
session.on?.("session.shutdown", (event) => {
  const reason = event?.data?.shutdownType ?? event?.data?.errorReason ?? "session_end";
  void shutdown(reason);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void shutdown(sig).finally(() => process.exit(0));
  });
}

if (identityFileWasPresent) void connectRelayWithRetry();

// Subscribe the encrypted channel and KEEP listening for phone hellos for the whole session. A
// transient Supabase subscribe failure (CHANNEL_ERROR) must not permanently kill pairing for a
// walk-away tool, so retry the subscribe with capped exponential backoff using a FRESH transport
// each attempt (a realtime channel is single-use after an error). Once subscribed, `listenForPeers`
// answers every hello — the first scan AND any later re-scan/reload — so pairing self-heals.
// `/helm` can re-kick this if all attempts gave up.
async function connectRelayWithRetry({ reconnect = false } = {}) {
  if (connecting || pairingStop || shuttingDown) return false;
  connecting = true;
  try {
    const maxAttempts = positiveIntFromEnv("HELM_CONNECT_MAX_ATTEMPTS", 6);
    for (let attempt = 1; !shuttingDown; attempt++) {
      const transport = createTransport({ channelId });
      try {
        const listener = await listenForPeers({
          transport,
          keyPair: laptopKeys,
          connect: true,
          channelId,
          onPeer: (info) => onPeerPaired(transport, info),
        });
        if (shuttingDown) {
          listener.stop();
          await closeQuietly(transport);
          return false;
        }
        pairingStop = listener.stop;
        activeTransport = transport;
        activeStatusStop = transport.onStatus?.((status, detail) => {
          if (status === "disconnected") requestReconnect(detail);
        }) ?? null;
        session.log?.(
          reconnect
            ? "Helm: reconnected."
            : "Helm: pairing channel ready; listening for phone hellos…",
        );
        return true;
      } catch (err) {
        await closeQuietly(transport);
        if (shuttingDown) return false;
        if (attempt >= maxAttempts) {
          process.stderr.write(
            `Helm: encrypted channel not ready after ${attempt} attempts: ${err?.message ?? err}\n`,
          );
          session.log?.(
            `Helm: pairing channel could not subscribe after ${attempt} attempts: ${err?.message ?? err}. Run /helm to retry.`,
            { level: "warning", ephemeral: false },
          );
          return false;
        }
        const backoffMs = Math.min(1500 * 2 ** (attempt - 1), 15_000);
        session.log?.(
          `Helm: pairing channel subscribe attempt ${attempt} failed (${err?.message ?? err}); retrying in ${Math.round(backoffMs / 1000)}s…`,
          { level: "warning", ephemeral: false },
        );
        await sleep(backoffMs);
      }
    }
  } finally {
    connecting = false;
  }
  return false;
}

function requestReconnect(detail) {
  if (shuttingDown || reconnecting) return;
  reconnecting = true;
  session.log?.("Helm: connection lost, reconnecting…", { level: "warning", ephemeral: false });
  void reconnectRelay(detail).finally(() => {
    reconnecting = false;
  });
}

async function reconnectRelay() {
  const previousRelay = relayHandle;
  const previousStop = pairingStop;
  const previousTransport = activeTransport;
  activeStatusStop?.();
  activeStatusStop = null;
  pairingStop = null;
  activeTransport = null;
  relayHandle = null;
  permissionRelay = null;
  currentPeerPub = null;
  try {
    previousStop?.();
  } catch {
    // best-effort; reconnect creates a fresh transport below.
  }
  if (previousRelay) {
    try {
      await previousRelay.stop("reconnect", { closeTransport: false });
    } catch {
      // best-effort; reconnect must continue.
    }
  }
  await closeQuietly(previousTransport);
  await connectRelayWithRetry({ reconnect: true });
}

// (Re)attach the encrypted relay for a freshly-paired phone. Serialized through `pairChain` so a
// phone re-broadcasting its hello can't trigger overlapping attaches, and idempotent per peer key:
// a duplicate hello from the same phone is already ACKed by `listenForPeers`, so we just no-op.
function onPeerPaired(transport, info) {
  pairChain = pairChain.then(() => attachForPeer(transport, info)).catch((err) => {
    session.log?.(`Helm: re-pair failed: ${err?.message ?? err}`, {
      level: "warning",
      ephemeral: false,
    });
  });
  return pairChain;
}

async function attachForPeer(transport, { key, peer }) {
  if (shuttingDown || transport !== activeTransport) return;
  if (peer.publicKeyB64 === currentPeerPub && relayHandle) return; // same phone re-saying hello

  const previous = relayHandle;
  relayHandle = null;
  currentPeerPub = null;
  if (previous) {
    // Tear down the old peer's relay but keep the shared transport open for this new phone.
    try {
      await previous.stop("repair", { closeTransport: false });
    } catch {
      // best-effort; a failed teardown must not block the new pairing.
    }
  }

  const channel = new SecureChannel({
    transport,
    key,
    identity: {
      channelId,
      sessionId: session.sessionId || "unknown-session",
      senderId: "copilot",
      senderName: "Copilot",
    },
  });
  permissionRelay = createPermissionRelay({
    channel,
    logger: (message, options) => session.log?.(message, options),
  });
  // SupabaseTransport is subscribe-order independent (single catch-all broadcast listener +
  // internal dispatch), so attachRelay may register SecureChannel handlers after the channel is
  // already connected without losing events.
  relayHandle = await attachRelay({
    session,
    channel,
    channelId,
    permissionRelay,
    onConnectionLost: requestReconnect,
  });
  relayHandle.session = session;
  currentPeerPub = peer.publicKeyB64;
  session.log?.(
    `${ui.lime("✓ Phone paired")} — ${peer.senderName ?? peer.deviceId ?? "your phone"} is now mirroring this session.`,
  );
}

// Tear everything down once: stop the pairing listener, stop the relay (which announces the session
// end + closes the shared transport), or just close the transport if no relay ever attached.
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  activeStatusStop?.();
  activeStatusStop = null;
  pairingStop?.();
  pairingStop = null;
  if (relayHandle) {
    try {
      await relayHandle.stop(reason);
    } catch {
      // best-effort
    }
  } else {
    await closeQuietly(activeTransport);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

async function closeQuietly(transport) {
  try {
    await transport?.close?.();
  } catch {
    // best-effort cleanup of a failed transport
  }
}

async function loadIdentityFromFile(file) {
  if (!file) return null;
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.channelId || !parsed.privateKeyJwk) {
      throw new Error("identity file is missing channelId or privateKeyJwk");
    }
    const laptopKeys = await importKeyPair({ privateKeyJwk: parsed.privateKeyJwk });
    return { channelId: parsed.channelId, laptopKeys };
  } catch (err) {
    process.stderr.write(`Helm: could not load handed-off identity; using a fresh pairing: ${err?.message ?? err}\n`);
    return null;
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // best-effort cleanup of the one-shot identity file
    }
  }
}

function positiveIntFromEnv(name, fallback) {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

async function logPairing(session, payload, { full = false } = {}) {
  const qr = (await QRCode.toString(payload, { type: "terminal", small: true })).replace(/\n+$/, "");
  const transport = process.env.HELM_TRANSPORT || "local";
  const channelShort = channelId.slice(0, 8);

  // Session start prints a light banner — just the QR + one status line. `/helm` prints the full
  // walk-through (value prop, numbered steps, manual-paste fallback, security footer).
  const lines = full
    ? [
        `${ui.brand("HELM")}  ${ui.dim("·  pair your phone")}`,
        "",
        ui.dim("Mirror this Copilot session on your phone — watch the live token"),
        ui.dim("stream, read diffs, and approve tool runs from anywhere."),
        "",
        qr,
        "",
        `${ui.lime("1")}  Open the Helm app   ${ui.dim("·")}  ${ui.cyan("usehelm.netlify.app")}`,
        `${ui.lime("2")}  Tap ${ui.dim("“Scan QR to pair”")} and point it at the code above`,
        `${ui.lime("3")}  Approve the link on your phone — it confirms right here`,
        "",
        ui.dim("Can’t scan? Tap “Paste a code” in the app and paste this:"),
        ui.dim(payload),
        "",
        ui.dim(
          `Relay ${transport} · Channel ${channelShort} · End-to-end encrypted (AES-256-GCM), keys live only this session`,
        ),
        "",
        `${ui.cyan("›")} ${ui.dim("Waiting for your phone…")}`,
      ]
    : [
        `${ui.brand("HELM")}  ${ui.dim("·  scan to pair your phone")}`,
        "",
        qr,
        "",
        `${ui.cyan("›")} ${ui.dim("Waiting for your phone…")}   ${ui.dim("·")}   ${ui.dim("run")} ${ui.lime("/helm")} ${ui.dim("for setup steps")}`,
      ];
  session.log?.(lines.join("\n"), { level: "info", ephemeral: false });
}

function createTransport({ channelId }) {
  const transportName = process.env.HELM_TRANSPORT || "local";
  if (transportName === "local") return createLocalTransport({ channelId });

  // Prefer Helm-namespaced vars. The generic SUPABASE_URL / SUPABASE_ANON_KEY are extremely
  // common and are frequently exported globally for an UNRELATED Supabase project; because an
  // already-exported env var beats our .env, that ambient value silently hijacks the relay and
  // the private-channel join is rejected (CHANNEL_ERROR). Namespacing avoids the collision; the
  // generic names stay as a fallback for "bring your own relay" users who only set those.
  const url = process.env.HELM_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.HELM_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Helm: HELM_TRANSPORT=supabase requires HELM_SUPABASE_URL and HELM_SUPABASE_ANON_KEY",
    );
  }
  if (!process.env.HELM_SUPABASE_URL || !process.env.HELM_SUPABASE_ANON_KEY) {
    process.stderr.write(
      `Helm: using generic SUPABASE_* env (relay host ${safeHost(url)}). Set ` +
        "HELM_SUPABASE_URL / HELM_SUPABASE_ANON_KEY so a global SUPABASE_URL for another " +
        "project cannot hijack the relay.\n",
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

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}
