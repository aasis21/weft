import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPairingPayload } from "../pairing.mjs";
import {
  decodePairingFragment,
  decodePairingInput,
  encodePairingLink,
  isPairingLink,
} from "../pairingLink.mjs";

const payload = buildPairingPayload({
  channelId: "chan-ü",
  publicKeyB64: "PUB",
  transport: { kind: "supabase", url: "https://x.supabase.co", anonKey: "sb_publishable_?/+=" },
  appVersion: "0.2.74",
});

test("a pairing link round-trips to the same payload", () => {
  const link = encodePairingLink(payload);
  assert.match(link, /^https:\/\/useweft\.netlify\.app\/pair#v3\.[A-Za-z0-9_-]+$/);
  assert.ok(isPairingLink(link));
  assert.deepEqual(decodePairingInput(link), payload);
  assert.deepEqual(decodePairingInput(`  ${link}\n`), payload);
  assert.deepEqual(decodePairingFragment(new URL(link).hash.slice(1)), payload);
  const local = encodePairingLink(payload, "http://127.0.0.1:5173/");
  assert.match(local, /^http:\/\/127\.0\.0\.1:5173\/pair#v3\./);
  assert.deepEqual(decodePairingInput(local), payload);
});

test("the payload stays in the fragment, never the path or query", () => {
  const url = new URL(encodePairingLink(payload));
  assert.equal(url.pathname, "/pair");
  assert.equal(url.search, "");
  assert.ok(!url.href.split("#")[0].includes(payload.token));
  const data = url.hash.slice("#v3.".length);
  assert.throws(() => decodePairingInput(`https://useweft.netlify.app/pair?v3.${data}`), /invalid pairing payload/);
  assert.throws(() => decodePairingInput(`https://useweft.netlify.app/pair/v3.${data}`), /invalid pairing payload/);
});

test("raw payload JSON (the paste format) is still accepted", () => {
  assert.deepEqual(decodePairingInput(JSON.stringify(payload)), payload);
  assert.deepEqual(decodePairingInput(`\n${JSON.stringify(payload, null, 2)}\n`), payload);
});

test("codes from a newer Weft ask for an update", () => {
  const data = new URL(encodePairingLink(payload)).hash.slice("#v3.".length);
  assert.throws(() => decodePairingInput(`https://useweft.netlify.app/pair#v4.${data}`), {
    message: "This code needs a newer Weft",
  });
  assert.throws(() => decodePairingInput(JSON.stringify({ ...payload, v: 3 })), {
    message: "This code needs a newer Weft",
  });
  assert.throws(() => decodePairingInput(encodePairingLink({ ...payload, v: 9 })), {
    message: "This code needs a newer Weft",
  });
});

test("garbage is rejected as an invalid pairing payload", () => {
  for (const input of [
    "",
    "hello",
    "{not json",
    "{}",
    "https://useweft.netlify.app/",
    "https://useweft.netlify.app/pair",
    "https://useweft.netlify.app/pair#v3.",
    "https://useweft.netlify.app/pair#v3.@@@",
    `https://useweft.netlify.app/pair#v3.${Buffer.from("not json").toString("base64url")}`,
    `https://useweft.netlify.app/pair#v3.${Buffer.from('{"v":2}').toString("base64url")}`,
    "javascript:alert(1)//pair#v3.e30",
  ]) {
    assert.throws(() => decodePairingInput(input), /invalid pairing payload/, input);
  }
  assert.throws(() => decodePairingInput(undefined), /invalid pairing payload/);
});
