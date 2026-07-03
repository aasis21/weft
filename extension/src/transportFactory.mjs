// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { createLocalTransport, createSupabaseTransport } from "@aasis21/helm-shared";

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

export function createTransport({ channelId }) {
  const transportName = process.env.HELM_TRANSPORT || "local";
  if (transportName === "local") return createLocalTransport({ channelId });

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
