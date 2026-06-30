// Type definitions for Helm shared crypto.

export interface KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** Base64 (raw, uncompressed point) — safe to embed in the pairing QR. */
  publicKeyB64: string;
}

export interface EncryptedPayload {
  /** Base64-encoded 96-bit IV. */
  iv: string;
  /** Base64-encoded AES-256-GCM ciphertext (includes auth tag). */
  ciphertext: string;
}

export function generateKeyPair(): Promise<KeyPair>;
export function exportPublicKeyB64(publicKey: CryptoKey): Promise<string>;
export function importPeerPublicKey(b64: string): Promise<CryptoKey>;
export function deriveSessionKey(
  privateKey: CryptoKey,
  peerPublicKeyB64: string
): Promise<CryptoKey>;
export function encryptJSON(key: CryptoKey, data: unknown): Promise<EncryptedPayload>;
export function decryptJSON(key: CryptoKey, payload: EncryptedPayload): Promise<unknown>;
export function randomChannelId(): string;

export const _internal: {
  bytesToB64(bytes: Uint8Array | ArrayBuffer): string;
  b64ToBytes(
    b64: string,
    options?: { label?: string; maxBytes?: number; allowEmpty?: boolean }
  ): Uint8Array;
};
