// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { WebPubSubClient } from "@azure/web-pubsub-client";
import {
  createLocalTransport,
  createSupabaseTransport,
  createWebPubSubTransport,
} from "@aasis21/helm-shared";

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
 * Resolve which transport + endpoint the laptop should use, purely from env — no client is
 * constructed here. This descriptor is (a) fed into createTransportFromDescriptor to build the
 * real transport, and (b) stamped into the pairing QR so the phone builds the SAME transport at
 * runtime with zero pre-baked config. Nothing returned here is a secret: Supabase's anon key is
 * meant to be public (RLS enforces access) and Web PubSub's negotiateUrl is just an endpoint —
 * the actual per-connection token is minted separately by that endpoint, never carried here.
 */
export function resolveTransportDescriptor() {
  const transportName = process.env.HELM_TRANSPORT || "local";
  if (transportName === "local") return { kind: "local" };

  if (transportName === "webpubsub") {
    const negotiateUrl = process.env.HELM_WEBPUBSUB_NEGOTIATE_URL;
    if (!negotiateUrl) {
      throw new Error(
        "Helm: HELM_TRANSPORT=webpubsub requires HELM_WEBPUBSUB_NEGOTIATE_URL",
      );
    }
    return { kind: "webpubsub", negotiateUrl };
  }

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
    // Helm uses *private* broadcast channels, authorized by RLS on realtime.messages
    // (see supabase/migrations). The anon key is the realtime access token; without
    // setAuth + the RLS policies applied, channel joins are denied.
    client.realtime.setAuth(descriptor.anonKey);
    return createSupabaseTransport({ client, channelId });
  }

  throw new Error(`Helm: unknown transport descriptor kind "${descriptor.kind}"`);
}

export function createTransport({ channelId }) {
  return createTransportFromDescriptor(resolveTransportDescriptor(), { channelId });
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
    throw new Error(`Helm: Web PubSub negotiate failed with status ${response.status}`);
  }
  const { url } = await response.json();
  if (!url) throw new Error('Helm: Web PubSub negotiate response missing "url"');
  return url;
}
