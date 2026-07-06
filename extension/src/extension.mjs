// SPDX-License-Identifier: Apache-2.0
import { readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import QRCode from "qrcode";
import { joinSession } from "@github/copilot-sdk/extension";
import {
  SecureChannel,
  generateKeyPair,
  importKeyPair,
  randomChannelId,
  buildPairingPayload,
  listenForPeers,
} from "@aasis21/weft-shared";
import { createTransportFromDescriptor, resolveTransportByName, resolveTransportForChannel, SUPPORTED_TRANSPORT_NAMES } from "./transportFactory.mjs";
import { attachRelay, createPermissionRelay } from "./relay.mjs";
import { provisionDevTunnelTransport, stopDevTunnel } from "./devtunnel.mjs";
import { weftHome } from "./projects.mjs";

// Names accepted by `/weft <name>` — the sync-resolvable ones (env/config-backed) plus the async,
// self-provisioning "devtunnel" path (see switchTransport below). Kept separate from
// transportFactory's own SUPPORTED_TRANSPORT_NAMES because devtunnel isn't a plain descriptor
// resolution: it spins up a local relay server + a real cloud tunnel on first use.
const WEFT_COMMAND_TRANSPORT_NAMES = [...SUPPORTED_TRANSPORT_NAMES, "devtunnel"];

// Minimal ANSI styling for the pairing banner. The Copilot CLI forwards ANSI straight to the
// terminal (the QR itself is rendered with ANSI escapes), so truecolor brand accents render in
// any modern terminal. Honor NO_COLOR (https://no-color.org) and TERM=dumb — otherwise the
// helpers just return the bare string, so the banner stays readable everywhere.
const WEFT_COLOR = !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (codes) => (s) => (WEFT_COLOR ? `\x1b[${codes}m${s}\x1b[0m` : `${s}`);
const ui = {
  brand: paint("1;38;2;198;242;78"), // bold signal-lime (#C6F24E) — Weft's primary
  lime: paint("38;2;198;242;78"),
  cyan: paint("38;2;63;224;206"), // secondary accent (#3FE0CE)
  dim: paint("2"),
};

// Best-effort: load SUPABASE_URL / SUPABASE_ANON_KEY / WEFT_TRANSPORT from a colocated
// `.env` so operators don't have to export them by hand before every `copilot`.
// Already-exported shell vars always win; a missing/unreadable file is a silent no-op.
// Never commit a real `.env` (it is gitignored).
function loadLocalEnv() {
  if (typeof parseEnv !== "function") return;
  const here = (() => {
    try {
      return dirname(fileURLToPath(import.meta.url));
    } catch {
      return null;
    }
  })();
  // ~/.weft/.env is the canonical, user-facing config location (kept alongside projects.json /
  // transport.json — see projects.mjs's weftHome()) so ~/.copilot/extensions/weft only ever
  // holds installed CODE, never user config. The old install-dir .env (next to the shipped
  // extension) and a launch-cwd .env remain as fallbacks for installs made before this split —
  // all three are merged (we do NOT stop after the first readable file) and ~/.weft wins ties.
  // Any already-exported process env still wins per key (see the collision note in
  // createTransport for why Weft uses WEFT_SUPABASE_* rather than generic SUPABASE_*).
  const candidates = [join(weftHome(), ".env")];
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

const handedOffIdentity = await loadIdentityFromFile(process.env.WEFT_IDENTITY_FILE);
const identityFileWasPresent = Boolean(handedOffIdentity);
const laptopKeys = handedOffIdentity?.laptopKeys ?? (await generateKeyPair());
const channelId = handedOffIdentity?.channelId ?? (process.env.WEFT_CHANNEL_ID || randomChannelId());
// Resolved once from this laptop's own env (WEFT_TRANSPORT / WEFT_SUPABASE_* / WEFT_WEBPUBSUB_*)
// or the persisted `weft set-transport` default, and stamped into the QR below so the phone
// builds a matching transport at connect time, with no pre-baked config of its own. A
// misconfigured transport (e.g. WEFT_TRANSPORT=webpubsub without WEFT_WEBPUBSUB_NEGOTIATE_URL) is
// not something pairing can work around, so this fails fast at load with a clear, actionable
// error rather than surfacing as a confusing retry-loop timeout later. resolveTransportForChannel
// (not the plain resolveTransportDescriptor) so a persisted default of "devtunnel" gets expanded
// into a real, connectable descriptor (spawns/reuses the shared relay — see devtunnel.mjs) right
// here at boot, not just when a user explicitly runs `/weft devtunnel` for the session.
// `let`, not `const` — `/weft <transport>` (see switchTransport) overrides this for just the
// running session without touching the persisted device-wide default.
let transportDescriptor = await resolveTransportForChannel({ channelId });
let pairingPayload = buildCurrentPairingPayload();

function buildCurrentPairingPayload() {
  return buildPairingPayload({
    channelId,
    publicKeyB64: laptopKeys.publicKeyB64,
    transport: transportDescriptor,
  });
}

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
// already answers re-scans, so we never stack a second transport. Bound to the `/weft` command.
// `context.args` (the text after `/weft`, e.g. "supabase") optionally overrides the transport for
// just this session — see switchTransport. No args (or blank) keeps this device's default.
const showPairing = async (context) => {
  const requested = context?.args?.trim();
  if (requested && !(await switchTransport(requested))) return;
  await logPairing(session, JSON.stringify(pairingPayload), { full: true });
  if (!pairingStop && !shuttingDown) void connectRelayWithRetry();
};

// Rebuild transportDescriptor/pairingPayload for `name` and tear down any live relay so the next
// connectRelayWithRetry() picks up the new transport. Returns false (after logging a clear error)
// for an unknown/misconfigured name, leaving the current transport untouched. This only affects
// the running session — it never writes to the persisted `weft set-transport` config.
async function switchTransport(name) {
  const normalized = name.trim().toLowerCase();
  if (normalized === "devtunnel") {
    session.log?.("Weft: setting up a devtunnel (first run creates a tunnel; can take ~10-20s)…", {
      ephemeral: false,
    });
  }
  let descriptor;
  try {
    descriptor =
      normalized === "devtunnel"
        ? await provisionDevTunnelTransport({ channelId })
        : resolveTransportByName(normalized);
  } catch (err) {
    session.log?.(`Weft: ${err?.message ?? err}`, { level: "warning", ephemeral: false });
    return false;
  }
  if (JSON.stringify(descriptor) === JSON.stringify(transportDescriptor)) {
    session.log?.(`Weft: already using "${descriptor.kind}" for this session.`, { ephemeral: false });
    return true;
  }
  transportDescriptor = descriptor;
  pairingPayload = buildCurrentPairingPayload();
  await teardownRelay("transport-switch");
  session.log?.(
    `Weft: switched transport to "${descriptor.kind}" for this session only. Scan the fresh QR below.`,
    { ephemeral: false },
  );
  return true;
}

const session = await joinSession({
  streaming: true,
  onPermissionRequest: async (request, invocation) => {
    if (!permissionRelay) {
      // No phone is paired yet, so Weft has no remote user to ask. Report the user as
      // unavailable (a valid native decision kind) so the CLI falls back to its own
      // in-terminal approval prompt instead of erroring on an unknown decision.
      return { kind: "user-not-available" };
    }
    return permissionRelay.onPermissionRequest(request, invocation);
  },
  commands: [
    {
      name: "weft",
      description:
        'Pair your phone with this Copilot session (shows the QR + setup steps). Optional arg overrides the transport for this session only: /weft [' +
        WEFT_COMMAND_TRANSPORT_NAMES.join("|") +
        "].",
      handler: showPairing,
    },
  ],
});

// A one-line hint on every session start, same idea as vox's boot log — tells the operator this
// extension is live and how to reach it, without waiting for them to already know `/weft` exists.
session.log?.(`${ui.brand("Weft loaded")} — run ${ui.cyan("/weft")} to pair your phone for a remote session.`);

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
// `/weft` can re-kick this if all attempts gave up.
async function connectRelayWithRetry({ reconnect = false } = {}) {
  if (connecting || pairingStop || shuttingDown) return false;
  connecting = true;
  try {
    const maxAttempts = positiveIntFromEnv("WEFT_CONNECT_MAX_ATTEMPTS", 6);
    for (let attempt = 1; !shuttingDown; attempt++) {
      const transport = createTransportFromDescriptor(transportDescriptor, { channelId });
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
            ? "Weft: reconnected."
            : "Weft: pairing channel ready; listening for phone hellos…",
        );
        return true;
      } catch (err) {
        await closeQuietly(transport);
        if (shuttingDown) return false;
        if (attempt >= maxAttempts) {
          process.stderr.write(
            `Weft: encrypted channel not ready after ${attempt} attempts: ${err?.message ?? err}\n`,
          );
          session.log?.(
            `Weft: pairing channel could not subscribe after ${attempt} attempts: ${err?.message ?? err}. Run /weft to retry.`,
            { level: "warning", ephemeral: false },
          );
          return false;
        }
        const backoffMs = Math.min(1500 * 2 ** (attempt - 1), 15_000);
        session.log?.(
          `Weft: pairing channel subscribe attempt ${attempt} failed (${err?.message ?? err}); retrying in ${Math.round(backoffMs / 1000)}s…`,
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
  session.log?.("Weft: connection lost, reconnecting…", { level: "warning", ephemeral: false });
  void reconnectRelay(detail).finally(() => {
    reconnecting = false;
  });
}

async function reconnectRelay() {
  await teardownRelay("reconnect");
  await connectRelayWithRetry({ reconnect: true });
}

// Shared shutdown of any live relay/listener/transport, used by both a dropped-connection
// reconnect and a user-requested `/weft <transport>` switch — `reason` is only used for the
// relay's own stop() bookkeeping/logging.
async function teardownRelay(reason) {
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
      await previousRelay.stop(reason, { closeTransport: false });
    } catch {
      // best-effort; reconnect must continue.
    }
  }
  await closeQuietly(previousTransport);
}

// (Re)attach the encrypted relay for a freshly-paired phone. Serialized through `pairChain` so a
// phone re-broadcasting its hello can't trigger overlapping attaches, and idempotent per peer key:
// a duplicate hello from the same phone is already ACKed by `listenForPeers`, so we just no-op.
function onPeerPaired(transport, info) {
  pairChain = pairChain.then(() => attachForPeer(transport, info)).catch((err) => {
    session.log?.(`Weft: re-pair failed: ${err?.message ?? err}`, {
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
  await stopDevTunnel().catch(() => {});
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
    process.stderr.write(`Weft: could not load handed-off identity; using a fresh pairing: ${err?.message ?? err}\n`);
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
  // Reflects whichever descriptor is actually active for THIS session — not just the env var —
  // so a `/weft <name>` override (see switchTransport) shows correctly after a switch.
  const transport = transportDescriptor.kind;
  const channelShort = channelId.slice(0, 8);

  // Session start prints a light banner — just the QR + one status line. `/weft` prints the full
  // walk-through (value prop, numbered steps, manual-paste fallback, security footer).
  const lines = full
    ? [
        `${ui.brand("WEFT")}  ${ui.dim("·  pair your phone")}`,
        "",
        ui.dim("Mirror this Copilot session on your phone — watch the live token"),
        ui.dim("stream, read diffs, and approve tool runs from anywhere."),
        "",
        qr,
        "",
        `${ui.lime("1")}  Open the Weft app   ${ui.dim("·")}  ${ui.cyan("useweft.netlify.app")}`,
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
        `${ui.brand("WEFT")}  ${ui.dim("·  scan to pair your phone")}`,
        "",
        qr,
        "",
        `${ui.cyan("›")} ${ui.dim("Waiting for your phone…")}   ${ui.dim("·")}   ${ui.dim("run")} ${ui.lime("/weft")} ${ui.dim("for setup steps")}`,
      ];
  session.log?.(lines.join("\n"), { level: "info", ephemeral: false });
}
