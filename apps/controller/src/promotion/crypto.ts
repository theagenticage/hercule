/**
 * The transfer key of a promotion (spec 13 section 2.3).
 *
 * The old controller encrypts every secret in its copy of the database under
 * the transfer key, and the new machine decrypts them with the same key. Both
 * derive it from the promotion token, so the key itself never travels. It is
 * HKDF-SHA256 over the token's 32 bytes, with a random 32-byte salt that
 * travels in the transfer header and the info label `hercule-promotion-v1`.
 * A slow password KDF is not needed, because the token is random.
 */
import * as Effect from "effect/Effect";

const HKDF_INFO = new TextEncoder().encode("hercule-promotion-v1");

/** How many random bytes a promotion token holds; `mintToken` writes them base64url. */
const TOKEN_BYTES = 32;

/** How many bytes the HKDF salt holds. */
export const SALT_BYTES = 32;

/**
 * Decodes a promotion token to its bytes. Returns `undefined` when the text is
 * not 32 bytes in base64url, so it cannot be a promotion token.
 */
export const decodePromotionToken = (token: string): Uint8Array<ArrayBuffer> | undefined => {
  const bytes = decodeBase64Url(token);
  return bytes.byteLength === TOKEN_BYTES && encodeBase64Url(bytes) === token ? bytes : undefined;
};

/**
 * Derives the AES-256-GCM transfer key from the bytes of a promotion token
 * and the salt. The key can encrypt and decrypt, and cannot be exported.
 */
export const deriveTransferKey = (
  tokenBytes: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
): Effect.Effect<CryptoKey> =>
  Effect.promise(async () =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: HKDF_INFO },
      await crypto.subtle.importKey("raw", tokenBytes, "HKDF", false, ["deriveKey"]),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
  );

/** Decodes base64url text to bytes. Characters outside the alphabet are skipped. */
export const decodeBase64Url = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(text, "base64url"));

/** Encodes bytes as base64url text, without padding. */
export const encodeBase64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");
