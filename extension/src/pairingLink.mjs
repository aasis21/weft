// SPDX-License-Identifier: Apache-2.0
import { encodePairingLink } from "@aasis21/weft-shared";

/** The hosted Weft origin — the same base the installers and `weft update` use. */
export function weftSiteOrigin(env = process.env) {
  return (env.WEFT_INSTALL_BASE || "https://useweft.netlify.app").replace(/\/+$/, "");
}

/** QR text for a pairing payload: a `/pair#v3.` link a phone camera can open directly. */
export function pairingQrText(payload, env = process.env) {
  return encodePairingLink(payload, weftSiteOrigin(env));
}
