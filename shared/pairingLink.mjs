// Weft pairing links.
//
// The laptop QR is a link to the hosted app — `https://useweft.netlify.app/pair#v3.<base64url(JSON)>`
// — so a phone camera can open the Android app (App Links) or the web app directly. The payload is a
// bearer credential: it lives only in the URL fragment, which browsers never send to a server.
// In-app Scan and Paste accept both the link and the raw payload JSON.

import { PAIR_VERSION, parsePairingPayload } from "./pairing.mjs";

export const PAIRING_LINK_VERSION = 3;
export const DEFAULT_PAIRING_LINK_BASE = "https://useweft.netlify.app";
export const NEWER_WEFT_MESSAGE = "This code needs a newer Weft";
const INVALID_MESSAGE = "weft/pairing: invalid pairing payload";
const FRAGMENT_RE = /^#v(\d+)\.(.*)$/s;

function invalid() {
  return new Error(INVALID_MESSAGE);
}

function base64UrlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let b64;
  if (typeof Buffer !== "undefined") b64 = Buffer.from(bytes).toString("base64");
  else {
    let bin = "";
    for (const byte of bytes) bin += String.fromCharCode(byte);
    b64 = btoa(bin);
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(data) {
  if (!data || !/^[A-Za-z0-9_-]+$/.test(data) || data.length % 4 === 1) throw invalid();
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (data.length % 4)) % 4);
  let bytes;
  if (typeof Buffer !== "undefined") bytes = Buffer.from(b64, "base64");
  else bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid();
  }
}

/** Build the pairing link shown in the laptop QR. The payload is carried only in the fragment. */
export function encodePairingLink(payload, base = DEFAULT_PAIRING_LINK_BASE) {
  if (!payload || typeof payload !== "object") throw new Error("weft/pairing: payload is required");
  const origin = String(base || DEFAULT_PAIRING_LINK_BASE).replace(/\/+$/, "");
  return `${origin}/pair#v${PAIRING_LINK_VERSION}.${base64UrlEncode(JSON.stringify(payload))}`;
}

/** Validate a decoded payload object; a payload from a future Weft gets an upgrade message. */
function validated(payload) {
  if (payload && typeof payload === "object" && Number.isInteger(payload.v) && payload.v > PAIR_VERSION) {
    throw new Error(NEWER_WEFT_MESSAGE);
  }
  parsePairingPayload(payload);
  return payload;
}

/** True when text is a URL whose path is `/pair` (any origin), i.e. a pairing link. */
export function isPairingLink(text) {
  if (typeof text !== "string") return false;
  try {
    const url = new URL(text.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && /^\/pair\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Decode a pairing link fragment (`#v3.<data>`, with or without the leading `#`) into the payload.
 * Unknown versions throw NEWER_WEFT_MESSAGE.
 */
export function decodePairingFragment(fragment) {
  const hash = typeof fragment === "string" && !fragment.startsWith("#") ? `#${fragment}` : fragment;
  const match = typeof hash === "string" ? FRAGMENT_RE.exec(hash) : null;
  if (!match) throw invalid();
  if (Number(match[1]) !== PAIRING_LINK_VERSION) throw new Error(NEWER_WEFT_MESSAGE);
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(match[2]));
  } catch (err) {
    if (err instanceof Error && err.message === INVALID_MESSAGE) throw err;
    throw invalid();
  }
  return validated(payload);
}

/**
 * Accept what a user scans or pastes — a pairing link or the raw payload JSON — and return the
 * validated payload object. Throws "weft/pairing: invalid pairing payload" for anything else.
 */
export function decodePairingInput(text) {
  if (typeof text !== "string") throw invalid();
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      throw invalid();
    }
    return validated(payload);
  }
  if (!isPairingLink(trimmed)) throw invalid();
  return decodePairingFragment(new URL(trimmed).hash);
}
