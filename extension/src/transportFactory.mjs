// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { WebPubSubClient } from "@azure/web-pubsub-client";
import WebSocket from "ws";
import {
  createLocalTransport,
  createSupabaseTransport,
  createWebPubSubTransport,
  createRelayTransport,
} from "@aasis21/weft-shared";
import { loadTransportConfig } from "./transportConfig.mjs";
import { provisionDevTunnelTransport } from "./devtunnel.mjs";

export function loadLocalEnv({ files } = {}) {
  if (typeof parseEnv !== "function") return;
  const candidates = files ?? defaultEnvFiles();
  for (const file of candidates) {
    try {
      const parsed = parseEnv(readFileSync(file, "utf8"));
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
    } catch {
      // Try the next candidate.
    }
  }
}

function defaultEnvFiles() {
  const candidates = [];
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), ".env"));
  } catch {
    // import.meta.url should be file:, but keep this loader defensive.
  }
  candidates.push(join(process.cwd(), ".env"));
  return candidates;
}

/**
 * Resolve which transport + endpoint the laptop should use — no client is constructed here.
 * This descriptor is (a) fed into createTransportFromDescriptor to build the real transport, and
 * (b) stamped into the pairing QR so the phone builds the SAME transport at runtime with zero
 * pre-baked config. Nothing returned here is a secret: Supabase's anon key is meant to be public
 * (RLS enforces access) and Web PubSub's negotiateUrl is just an endpoint — the actual
 * per-connection token is minted separately by that endpoint, never carried here.
 *
 * Precedence: an explicit WEFT_TRANSPORT env var (e.g. from a repo-root .env, for CI/power-user
 * overrides) wins outright. Otherwise, the persisted choice from `weft set-transport` (see
 * transportConfig.mjs) applies. With neither set, Weft defaults to Supabase — Weft's own relay is
 * the supported out-of-the-box path — reading WEFT_SUPABASE_URL/WEFT_SUPABASE_ANON_KEY (or the
 * generic SUPABASE_* fallback); `local` is opt-in only, for same-machine testing.
 *
 * This is "this device's default" — the one `/weft` (no arguments) pairs with. `/weft <name>`
 * overrides it for a single running session via resolveTransportByName below, without touching
 * the persisted device-wide config.
 */
export function resolveTransportDescriptor({ baseDir } = {}) {
  if (process.env.WEFT_TRANSPORT) {
    return resolveFromEnv(process.env.WEFT_TRANSPORT);
  }

  const configured = loadTransportConfig({ baseDir });
  if (configured) return configured;

  try {
    return resolveFromEnv("supabase");
  } catch (err) {
    throw new Error(
      `${err.message}\nWeft: no transport configured. Run \`weft set-transport supabase ` +
        "--url <url> --anon-key <key>\` (or `weft set-transport local` to test without a " +
        "relay) to choose one.",
    );
  }
}

/**
 * Transport kinds a user can pick via a user-facing command (`weft set-transport`, `/weft
 * <name>`). Only the two "supported" transports Weft documents/installs are listed here:
 * Supabase (hosted, zero-config) and devtunnel (self-hosted local relay, no cloud account) — see
 * WEFT_COMMAND_TRANSPORT_NAMES in extension.mjs, which adds "devtunnel" back in for the /weft
 * command specifically since it needs a channelId to provision and can't go through the plain
 * resolveTransportByName() below. "local" and "webpubsub" remain fully implemented (resolveFromEnv
 * below, createTransportFromDescriptor) for internal testing / advanced WEFT_TRANSPORT env
 * overrides — they're just no longer offered or documented anywhere a user would see them.
 */
export const SUPPORTED_TRANSPORT_NAMES = ["supabase"];

/**
 * Requires a name from SUPPORTED_TRANSPORT_NAMES (case-insensitive); throws a single
 * user-facing message (listing the valid names) for anything else, so callers like /weft's
 * handler can surface it directly without re-deriving the allowed list themselves.
 */
export function resolveTransportByName(transportName) {
  const normalized = String(transportName ?? "").trim().toLowerCase();
  if (!SUPPORTED_TRANSPORT_NAMES.includes(normalized)) {
    throw new Error(
      `Weft: unknown transport "${transportName}". Supported: ${SUPPORTED_TRANSPORT_NAMES.join(", ")}.`,
    );
  }
  return resolveFromEnv(normalized);
}

function resolveFromEnv(transportName) {
  if (transportName === "local") return { kind: "local" };
  if (transportName === "devtunnel") return { kind: "devtunnel" };

  if (transportName === "webpubsub") {
    const negotiateUrl = process.env.WEFT_WEBPUBSUB_NEGOTIATE_URL;
    if (!negotiateUrl) {
      throw new Error(
        "Weft: WEFT_TRANSPORT=webpubsub requires WEFT_WEBPUBSUB_NEGOTIATE_URL",
      );
    }
    return { kind: "webpubsub", negotiateUrl };
  }

  const url = process.env.WEFT_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.WEFT_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Weft: WEFT_TRANSPORT=supabase requires WEFT_SUPABASE_URL and WEFT_SUPABASE_ANON_KEY",
    );
  }
  if (!process.env.WEFT_SUPABASE_URL || !process.env.WEFT_SUPABASE_ANON_KEY) {
    process.stderr.write(
      `Weft: using generic SUPABASE_* env (relay host ${safeHost(url)}). Set ` +
        "WEFT_SUPABASE_URL / WEFT_SUPABASE_ANON_KEY so a global SUPABASE_URL for another " +
        "project cannot hijack the relay.\n",
    );
  }
  return { kind: "supabase", url, anonKey };
}

/** Build a live Transport from a resolved/parsed descriptor (see resolveTransportDescriptor). */
export function createTransportFromDescriptor(descriptor, { channelId }) {
  if (descriptor.kind === "local") return createLocalTransport({ channelId });

  if (descriptor.kind === "webpubsub") {
    // Web PubSub tokens are short-lived, unlike the long-lived Supabase anon key below — the
    // credential's getClientAccessUrl() lets the SDK transparently re-negotiate on reconnect.
    const client = new WebPubSubClient({
      getClientAccessUrl: () =>
        fetchWebPubSubClientAccessUrl(descriptor.negotiateUrl, channelId),
    });
    return createWebPubSubTransport({ client, channelId });
  }

  if (descriptor.kind === "supabase") {
    const client = createClient(descriptor.url, descriptor.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Weft uses *private* broadcast channels, authorized by RLS on realtime.messages
    // (see supabase/migrations). The anon key is the realtime access token; without
    // setAuth + the RLS policies applied, channel joins are denied.
    client.realtime.setAuth(descriptor.anonKey);
    return createSupabaseTransport({ client, channelId });
  }

  if (descriptor.kind === "devtunnel") {
    // descriptor.url already carries ?channelId=… (see devtunnel.mjs) so the relay server on the
    // other end of the tunnel can room-match this socket with the phone's — createRelayTransport
    // itself never puts channelId on the wire (see shared/transport-relay.mjs).
    const socket = new WebSocket(descriptor.url);
    return createRelayTransport({ socket, channelId });
  }

  throw new Error(`Weft: unknown transport descriptor kind "${descriptor.kind}"`);
}

export function createTransport({ channelId }) {
  return createTransportFromDescriptor(resolveTransportDescriptor(), { channelId });
}

/**
 * Like resolveTransportDescriptor, but expands a persisted/env "devtunnel" choice into a real,
 * connectable descriptor (spawning/reusing the shared relay+tunnel — see devtunnel.mjs) since that
 * requires a channelId up front and can't happen inside the plain synchronous resolver. Every
 * caller that needs a descriptor it can actually connect with (as opposed to just displaying the
 * configured kind, e.g. `weft show-transport`) should call this instead of
 * resolveTransportDescriptor() directly.
 */
export async function resolveTransportForChannel({ baseDir, channelId } = {}) {
  const descriptor = resolveTransportDescriptor({ baseDir });
  if (descriptor.kind === "devtunnel") {
    return provisionDevTunnelTransport({ channelId, baseDir });
  }
  return descriptor;
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}

/**
 * Calls a self-hosted negotiate endpoint (e.g. an Azure Function) which holds the Web
 * PubSub connection string secret and mints a short-lived client access URL scoped to this
 * channel's group.
 */
async function fetchWebPubSubClientAccessUrl(negotiateUrl, channelId) {
  const response = await fetch(`${negotiateUrl}?channelId=${encodeURIComponent(channelId)}`);
  if (!response.ok) {
    throw new Error(`Weft: Web PubSub negotiate failed with status ${response.status}`);
  }
  const { url } = await response.json();
  if (!url) throw new Error('Weft: Web PubSub negotiate response missing "url"');
  return url;
}
