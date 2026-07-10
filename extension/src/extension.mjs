// SPDX-License-Identifier: Apache-2.0
import { readFileSync, unlinkSync } from "node:fs";
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
import { provisionDevTunnelTransport, stopDevTunnel, describeStage } from "./devtunnel.mjs";

// Names accepted by `/weft <name>` — the sync-resolvable ones (config-backed) plus the async,
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

const handedOffIdentity = await loadIdentityFromFile(process.env.WEFT_IDENTITY_FILE);
const identityFileWasPresent = Boolean(handedOffIdentity);
// Each Copilot session always gets its own fresh channel + keypair (forward-secret, and required
// for the relay's 1-peer-per-channel binding — see listener.mjs's boundPeerPub / bindPeer). The
// only exception is a same-session handoff identity (e.g. after /clear), which must be reused
// verbatim so the phone recognizes it as a continuation of the same session, not a new one.
// Persistent pairing (`weft set-pairing persistent`) is a `weft start`-only concept (see
// listener.mjs) — it never applies here, since sharing one channel across multiple live Copilot
// sessions would mean the relay ACKs/serves the phone's hello from more than one process at once.
const laptopKeys = handedOffIdentity?.laptopKeys ?? (await generateKeyPair());
const channelId = handedOffIdentity?.channelId ?? (process.env.WEFT_CHANNEL_ID || randomChannelId());
// Resolved once from the single ~/.weft/weft.config.json config file written by `weft
// set-transport` (see transportFactory.mjs — there is no env var / .env fallback, so a
// reinstall/rebuild of the extension can never silently override this), and stamped into the QR
// below so the phone builds a matching transport at connect time, with no pre-baked config of its
// own. An unconfigured transport fails fast at load with a clear, actionable error (telling the
// user to run `weft set-transport`) rather than surfacing as a confusing retry-loop timeout later.
// resolveTransportForChannel (not the plain resolveTransportDescriptor) so a persisted default of
// "devtunnel" gets expanded into a real, connectable descriptor (spawns/reuses the shared relay —
// see devtunnel.mjs) right here at boot, not just when a user explicitly runs `/weft devtunnel`
// for the session.
// `let`, not `const` — `/weft <transport>` (see switchTransport) overrides this for just the
// running session without touching the persisted device-wide default.
//
// A misbehaving devtunnel (CLI missing, not logged in, or the shared relay not coming up within
// PROVISION_TIMEOUT_MS — see devtunnel.mjs) must NOT crash the whole extension at load: that would
// take down the entire Copilot session over a Weft-only feature. So this is caught here; a null
// transportDescriptor just means pairing isn't available yet. The error is surfaced via
// session.log once `session` exists (see below `if (transportSetupError)` block), and the user can
// retry any time with `/weft <name>` (switchTransport already has its own try/catch).
let transportDescriptor = null;
let transportSetupError = null;
try {
  transportDescriptor = await resolveTransportForChannel({ channelId });
} catch (err) {
  transportSetupError = err;
}
let pairingPayload = transportDescriptor ? buildCurrentPairingPayload() : null;

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
  if (!transportDescriptor) {
    session.log?.(
      `Weft: no working transport yet (${transportSetupError?.message ?? "not configured"}). ` +
        `Run \`/weft [${WEFT_COMMAND_TRANSPORT_NAMES.join("|")}]\` to pick one.`,
      { level: "warning", ephemeral: false },
    );
    return;
  }
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
    session.log?.("Weft: setting up a devtunnel (first run creates a tunnel; this can take a couple of minutes)…", {
      ephemeral: false,
    });
  }
  let descriptor;
  try {
    descriptor =
      normalized === "devtunnel"
        ? await provisionDevTunnelTransport({
            channelId,
            // Surfaces real progress instead of silence — see devtunnel.mjs's STAGE_LABELS.
            onProgress: (stage) => session.log?.(`Weft: ${describeStage(stage)}`, { ephemeral: false }),
            // A 45s cycle elapsed with no success yet; the detached relay keeps working in the
            // background regardless, so just let the user know we're still watching it rather
            // than failing outright (provisionDevTunnelTransport caps this at ~2 minutes total).
            onRetry: (attempt, maxAttempts) =>
              session.log?.(`Weft: still setting up the devtunnel (attempt ${attempt + 1}/${maxAttempts})…`, {
                ephemeral: false,
              }),
          })
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
  transportSetupError = null;
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

if (transportSetupError) {
  session.log?.(
    `Weft: transport didn't come up at startup (${transportSetupError.message}). ` +
      `Run \`/weft [${WEFT_COMMAND_TRANSPORT_NAMES.join("|")}]\` to configure/retry it.`,
    { level: "warning", ephemeral: false },
  );
}

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
  if (!transportDescriptor) return false; // boot-time transport setup failed; see /weft to retry.
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
        // Fenced as a code block (not just ui.dim(payload)) so the CLI's own markdown renderer
        // treats it as literal text: a bare "https://..." inside the raw JSON was otherwise being
        // auto-hyperlinked (OSC 8) by the renderer's markdown autolink pass, splicing escape
        // sequences into the middle of the string and corrupting the exact bytes the user must
        // copy/paste into the phone app.
        "```",
        payload,
        "```",
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
