// SPDX-License-Identifier: Apache-2.0
// Weft — a human-readable identity for a TransportDescriptor, rendered IDENTICALLY on the station
// (the `weft start` banner) and on the phone (the device "comms identifiers"). Showing the same
// string on both ends lets a user eyeball-confirm that laptop and phone are talking over the exact
// same relay/endpoint when a pairing looks stuck.

function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return String(url ?? "");
  }
}

/**
 * Derive a stable, display-friendly identity for a transport descriptor.
 * @param {import("./transport").TransportDescriptor | null | undefined} descriptor
 * @returns {{ kind: string, id: string, label: string }} `kind` is the transport kind; `id` is the
 *   concise endpoint identifier both ends compare on; `label` is `"<kind> · <id>"` for direct display.
 */
export function transportIdentity(descriptor) {
  const kind = descriptor?.kind ?? "unknown";
  if (kind === "devtunnel" || kind === "supabase") {
    const id = hostOf(descriptor.url);
    return { kind, id, label: `${kind} · ${id}` };
  }
  if (kind === "local") {
    return { kind, id: "local", label: "local" };
  }
  return { kind, id: kind, label: kind };
}
