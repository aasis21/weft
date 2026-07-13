// transportIdentity renders a stable, display-friendly identity for a transport descriptor —
// the SAME string is shown on the `weft start` banner and the phone's device comms identifiers,
// so a user can eyeball-confirm both ends share one relay.

import { test } from "node:test";
import assert from "node:assert/strict";

import { transportIdentity } from "../transport-identity.mjs";

test("devtunnel identity uses the tunnel host", () => {
  const id = transportIdentity({ kind: "devtunnel", url: "wss://mcfss6vf-62227.usw2.devtunnels.ms" });
  assert.equal(id.kind, "devtunnel");
  assert.equal(id.id, "mcfss6vf-62227.usw2.devtunnels.ms");
  assert.equal(id.label, "devtunnel · mcfss6vf-62227.usw2.devtunnels.ms");
});

test("supabase identity uses the project host", () => {
  const id = transportIdentity({ kind: "supabase", url: "https://abcdefgh.supabase.co", anonKey: "k" });
  assert.equal(id.id, "abcdefgh.supabase.co");
  assert.equal(id.label, "supabase · abcdefgh.supabase.co");
});

test("local identity is a plain label", () => {
  const id = transportIdentity({ kind: "local" });
  assert.deepEqual(id, { kind: "local", id: "local", label: "local" });
});

test("missing / unknown descriptor degrades gracefully", () => {
  assert.equal(transportIdentity(null).kind, "unknown");
  assert.equal(transportIdentity(undefined).label, "unknown");
});

test("unparseable url falls back to the raw string", () => {
  const id = transportIdentity({ kind: "devtunnel", url: "not a url" });
  assert.equal(id.id, "not a url");
});
