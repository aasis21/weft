// SPDX-License-Identifier: Apache-2.0
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import {
  createLocalTransport,
  createSupabaseTransport,
  createRelayTransport,
} from "@aasis21/weft-shared";
import { loadTransportConfig } from "./transportConfig.mjs";
import { resolveDevTunnelTransport } from "./devtunnel.mjs";

/**
 * Resolve which transport + endpoint the laptop should use — no client is constructed here.
 * This descriptor is (a) fed into createTransportFromDescriptor to build the real transport, and
 * (b) stamped into the pairing QR so the phone builds the SAME transport at runtime with zero
 * pre-baked config. Nothing returned here is a secret: Supabase's anon key is meant to be public
 * (RLS enforces access on realtime.messages).
 *
 * The ONLY source of truth is ~/.weft/weft.config.json (see transportConfig.mjs), written by
 * `weft set-transport`. There is deliberately no env var override (no WEFT_TRANSPORT, no .env) —
 * a rebuild/reinstall only ever refreshes installed code under ~/.copilot/extensions/weft, never
 * this config file, so it can never silently overwrite (or be silently shadowed by a stray env
 * var/leftover .env for) the user's chosen transport. If nothing is configured yet, this throws
 * an actionable error rather than guessing a default.
 *
 * This is "this device's default" — the one `/weft` (no arguments) pairs with. `/weft <name>`
 * overrides it for a single running session via resolveTransportByName below, without touching
 * the persisted device-wide config.
 */
export function resolveTransportDescriptor({ baseDir } = {}) {
  const configured = loadTransportConfig({ baseDir });
  if (configured) return configured;
  throw new Error(
    "Weft: no transport configured. Run `weft set-transport supabase --url <url> --anon-key " +
      "<key>` (or `weft set-transport devtunnel` for a self-hosted relay, no cloud account) to " +
      "choose one. This is stored once in ~/.weft/weft.config.json.",
  );
}

/**
 * Transport kinds a user can pick via a user-facing command (`weft set-transport`, `/weft
 * <name>`). Only the two "supported" transports Weft documents/installs are listed here:
 * Supabase (hosted, zero-config) and devtunnel (self-hosted local relay, no cloud account) — see
 * WEFT_COMMAND_TRANSPORT_NAMES in extension.mjs, which adds "devtunnel" back in for the /weft
 * command specifically since it needs a channelId to provision and can't go through the plain
 * resolveTransportByName() below. "local" remains fully implemented (createTransportFromDescriptor)
 * for the harness/tests, but is not offered by any user-facing command.
 */
export const SUPPORTED_TRANSPORT_NAMES = ["supabase"];

/**
 * Requires a name from SUPPORTED_TRANSPORT_NAMES (case-insensitive); throws a single
 * user-facing message (listing the valid names) for anything else, so callers like /weft's
 * handler can surface it directly without re-deriving the allowed list themselves. Reads the
 * SAME persisted config as resolveTransportDescriptor — there is no env var path — so `/weft
 * supabase` only works once `weft set-transport supabase --url <url> --anon-key <key>` has
 * actually been run.
 */
export function resolveTransportByName(transportName, { baseDir } = {}) {
  const normalized = String(transportName ?? "").trim().toLowerCase();
  if (!SUPPORTED_TRANSPORT_NAMES.includes(normalized)) {
    throw new Error(
      `Weft: unknown transport "${transportName}". Supported: ${SUPPORTED_TRANSPORT_NAMES.join(", ")}.`,
    );
  }
  const configured = loadTransportConfig({ baseDir });
  if (configured?.kind !== normalized) {
    throw new Error(
      `Weft: no ${normalized} transport configured. Run \`weft set-transport ${normalized} ` +
        "--url <url> --anon-key <key>` first.",
    );
  }
  return configured;
}

/** Build a live Transport from a resolved/parsed descriptor (see resolveTransportDescriptor). */
export function createTransportFromDescriptor(descriptor, { channelId }) {
  if (descriptor.kind === "local") return createLocalTransport({ channelId });

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
    // Same shape as the supabase branch above: the descriptor carries only connection info
    // (`{kind, url: baseUrl}` — see resolveDevTunnelTransport), and channel/room selection is
    // applied here at socket-construction time. The relay server on the other end of the tunnel
    // (see relayServer.mjs) reads `?channelId=` from the incoming URL to room-match this socket
    // with the phone's; createRelayTransport itself never puts channelId on the wire (see
    // shared/transport-relay.mjs).
    const socket = new WebSocket(withChannelId(descriptor.url, channelId));
    return createRelayTransport({ socket, channelId });
  }

  throw new Error(`Weft: unknown transport descriptor kind "${descriptor.kind}"`);
}

export function createTransport({ channelId }) {
  return createTransportFromDescriptor(resolveTransportDescriptor(), { channelId });
}

/**
 * Like resolveTransportDescriptor, but expands a persisted "devtunnel" choice into a real,
 * connectable descriptor by looking up the shared relay + tunnel that `weft devtunnel start`
 * provisions on this machine (see devtunnel.mjs). Async because that lookup is a live probe of
 * the running relay's registry file, which can't happen inside the plain synchronous resolver.
 * Throws if no relay is running, so the pairing path stays symmetric with the Supabase transport
 * (both just *use* the "server", they don't spawn it). No channelId here either, for the same
 * symmetry reason — the returned descriptor is channel-agnostic and channelId only enters the
 * picture at socket-construction time in createTransportFromDescriptor. Every caller that needs
 * a descriptor it can actually connect with (as opposed to just displaying the configured kind,
 * e.g. `weft show-transport`) should call this instead of resolveTransportDescriptor() directly.
 */
export async function resolveTransport({ baseDir } = {}) {
  const descriptor = resolveTransportDescriptor({ baseDir });
  if (descriptor.kind === "devtunnel") {
    return resolveDevTunnelTransport({ baseDir });
  }
  return descriptor;
}

/** Appends `?channelId=…` (or `&channelId=…` if the URL already has a query string) so a bare
 * relay baseUrl becomes a room-scoped connect URL — see the devtunnel branch of
 * createTransportFromDescriptor / mobile weftClient.ts, which both need identical behavior. */
function withChannelId(baseUrl, channelId) {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}channelId=${encodeURIComponent(channelId)}`;
}
