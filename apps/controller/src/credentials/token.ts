/**
 * Mints opaque tokens and hashes them for storage. This is the only place in
 * the controller that does either.
 *
 * Every credential Hercule issues - the setup token, a login bearer, an API key -
 * is 32 random bytes, encoded as base64url so it is safe in a URL, a header and
 * a JSON file. A credential that callers present is stored only as its hash
 * (`hashToken`), so a copy of the database contains no working credential. A
 * minted value that is not a credential, such as an OAuth `state` or a PKCE
 * verifier, is stored as it is, because the flow has to send it back.
 *
 * The hash is SHA-256. A token is 256 bits of uniform randomness, so there is
 * nothing to guess and a slow hash would add no protection. Looking a token up
 * stays one indexed equality lookup on the request path. Passwords are a
 * different case and use argon2id (`../users/password.ts`).
 */
import { createHash } from "node:crypto";

/** 256 bits: the same strength as the hash that stores it. */
const TOKEN_BYTES = 32;

/** Mints a new token: 32 random bytes, base64url-encoded. */
export const mintToken = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))).toString("base64url");

/** Hashes a token for storage and lookup: SHA-256, hex-encoded. */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
