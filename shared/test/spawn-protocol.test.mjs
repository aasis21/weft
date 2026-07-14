// #156 phone-launched sessions: protocol additions (pairing kind, keypair export/import,
// project/spawn/forget control factories). Kept dependency-free (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateKeyPair,
  exportKeyPair,
  importKeyPair,
  deriveSessionKey,
  encryptJSON,
  decryptJSON,
} from "../crypto.mjs";
import { buildPairingPayload, parsePairingPayload, PAIR_KIND } from "../pairing.mjs";
import {
  EVENT_TYPE,
  SUBTYPE,
  projectListRequest,
  projectList,
  spawnSession,
  spawnPairing,
  spawnResult,
  forgetDevice,
  sessionOffers,
  sessionClaimed,
  voiceMode,
  isValidEnvelope,
} from "../messages.mjs";

test("pairing payload carries an explicit listener kind, defaults to session", () => {
  const session = buildPairingPayload({ channelId: "c1", publicKeyB64: "AAAA", transport: { kind: "local" } });
  assert.equal(session.kind, undefined, "default session QR omits kind field for non-listener kinds");
  assert.equal(parsePairingPayload(session).kind, PAIR_KIND.SESSION);

  const listener = buildPairingPayload({
    channelId: "c2",
    publicKeyB64: "BBBB",
    transport: { kind: "local" },
    kind: PAIR_KIND.LISTENER,
  });
  assert.equal(listener.kind, "listener");
  const parsed = parsePairingPayload(JSON.stringify(listener));
  assert.equal(parsed.kind, PAIR_KIND.LISTENER);
  assert.equal(parsed.channelId, "c2");

  // Unknown kinds fall back to session (defensive).
  assert.equal(
    parsePairingPayload({ v: 1, channelId: "c3", pub: "x", kind: "bogus", transport: { kind: "local" } }).kind,
    PAIR_KIND.SESSION,
  );
});

test("exportKeyPair -> importKeyPair round-trips a working ECDH identity", async () => {
  const laptop = await generateKeyPair();
  const exported = await exportKeyPair(laptop);
  assert.equal(exported.publicKeyB64, laptop.publicKeyB64);
  assert.ok(exported.privateKeyJwk && typeof exported.privateKeyJwk === "object");

  // Simulate the identity file surviving JSON serialization.
  const restored = await importKeyPair(JSON.parse(JSON.stringify({ privateKeyJwk: exported.privateKeyJwk })));
  assert.equal(restored.publicKeyB64, laptop.publicKeyB64, "public key survives export/import");

  // A phone deriving against the ORIGINAL public key must match the RESTORED private key.
  const phone = await generateKeyPair();
  const phoneKey = await deriveSessionKey(phone.privateKey, restored.publicKeyB64);
  const restoredKey = await deriveSessionKey(restored.privateKey, phone.publicKeyB64);
  const enc = await encryptJSON(phoneKey, { hello: "spawned" });
  assert.deepEqual(await decryptJSON(restoredKey, enc), { hello: "spawned" });
});

test("spawn/project/forget factories build valid CONTROL envelopes", () => {
  const cases = [
    [projectListRequest(), SUBTYPE.CONTROL.PROJECT_LIST_REQUEST],
    [projectList([{ name: "web", path: "/w", isDefault: true }], "MacBook"), SUBTYPE.CONTROL.PROJECT_LIST],
    [spawnSession("r1", "web", "allow-all", "brave-otter"), SUBTYPE.CONTROL.SPAWN_SESSION],
    [spawnPairing("r1", { v: 1, channelId: "c", pub: "p" }, "brave-otter", "web"), SUBTYPE.CONTROL.SPAWN_PAIRING],
    [spawnResult("r1", false, "no such project"), SUBTYPE.CONTROL.SPAWN_RESULT],
    [forgetDevice(), SUBTYPE.CONTROL.FORGET_DEVICE],
  ];
  for (const [env, subtype] of cases) {
    assert.equal(env.eventType, EVENT_TYPE.CONTROL);
    assert.equal(env.eventSubtype, subtype);
    assert.ok(isValidEnvelope(env), `${subtype} is a valid envelope`);
  }

  assert.deepEqual(projectList(null).msg.projects, [], "projectList tolerates a nullish list");
  assert.equal(spawnSession("r2", "web").msg.mode, "default", "spawn mode defaults to 'default'");
  assert.equal(spawnResult("r3", true).msg.error, null);
});

test("voiceMode builds a CONTROL envelope with a boolean active flag", () => {
  const on = voiceMode(true);
  assert.equal(on.eventType, EVENT_TYPE.CONTROL);
  assert.equal(on.eventSubtype, SUBTYPE.CONTROL.VOICE_MODE);
  assert.equal(on.msg.active, true);
  assert.equal(voiceMode(0).msg.active, false, "coerces to boolean");
  assert.ok(isValidEnvelope(on));
});

test("sessionOffers filters to well-formed offers and normalizes fields", () => {
  const payload = { v: 1, channelId: "off-1", pub: "p", transport: { kind: "local" } };
  const env = sessionOffers([
    { channelId: "off-1", name: "web", cwd: "/repo/web", payload },
    { channelId: "off-2", name: "", cwd: "", payload }, // blank name/cwd -> null
    { channelId: "off-3" }, // no payload -> dropped
    { name: "no-channel", payload }, // no channelId -> dropped
    null, // junk -> dropped
  ]);
  assert.equal(env.eventType, EVENT_TYPE.CONTROL);
  assert.equal(env.eventSubtype, SUBTYPE.CONTROL.SESSION_OFFERS);
  assert.ok(isValidEnvelope(env));
  assert.equal(env.msg.offers.length, 2, "only offers with a channelId AND payload survive");
  assert.deepEqual(env.msg.offers[0], { channelId: "off-1", name: "web", cwd: "/repo/web", payload });
  assert.deepEqual(env.msg.offers[1], { channelId: "off-2", name: null, cwd: null, payload });
  assert.deepEqual(sessionOffers(null).msg.offers, [], "tolerates a nullish list");
});

test("sessionClaimed carries the offered channelId as a string", () => {
  const env = sessionClaimed("off-1");
  assert.equal(env.eventType, EVENT_TYPE.CONTROL);
  assert.equal(env.eventSubtype, SUBTYPE.CONTROL.SESSION_CLAIMED);
  assert.equal(env.msg.channelId, "off-1");
  assert.ok(isValidEnvelope(env));
  assert.equal(sessionClaimed(undefined).msg.channelId, "", "coerces a missing id to empty string");
});
