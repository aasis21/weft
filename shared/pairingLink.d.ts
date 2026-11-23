import type { PairingPayload } from "./pairing";

export declare const PAIRING_LINK_VERSION: 3;
export declare const DEFAULT_PAIRING_LINK_BASE: "https://useweft.netlify.app";
/** Error message for a pairing link or payload minted by a newer Weft. */
export declare const NEWER_WEFT_MESSAGE: "This code needs a newer Weft";

/** `${base}/pair#v3.<base64url(JSON)>` — the payload lives only in the fragment. */
export declare function encodePairingLink(payload: PairingPayload, base?: string): string;
/** True when text is an http(s) URL whose path is `/pair`. */
export declare function isPairingLink(text: string): boolean;
/** Decode `#v3.<data>` (leading `#` optional) into a validated payload. */
export declare function decodePairingFragment(fragment: string): PairingPayload;
/** Accept a pairing link or raw payload JSON and return the validated payload. */
export declare function decodePairingInput(text: string): PairingPayload;
