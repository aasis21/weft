// SPDX-License-Identifier: Apache-2.0
import type { TransportDescriptor } from "./transport";

export interface TransportIdentity {
  /** Transport kind: "local" | "supabase" | "devtunnel" | "unknown". */
  kind: string;
  /** Concise endpoint identifier both ends compare on (host for supabase/devtunnel). */
  id: string;
  /** `"<kind> · <id>"`, ready for direct display. */
  label: string;
}

/** Derive a stable, display-friendly identity for a transport descriptor. */
export function transportIdentity(descriptor: TransportDescriptor | null | undefined): TransportIdentity;
