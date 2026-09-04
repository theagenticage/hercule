/**
 * How Hydra mints and stores an opaque token: the one place in the controller
 * that does either.
 *
 * Every credential Hydra issues - the setup token, a login bearer, an API key -
 * is the same thing: 32 random bytes, rendered base64url so it survives a URL,
 * a header and a JSON file. Only the hash is stored, so a copy of the database
 * hands nobody a working credential.
 *
 * The hash is SHA-256. A token is 256 bits of uniform randomness with nothing
 * to guess, so the slow-hash argument does not apply, and resolution stays one
 * indexed equality lookup on the request path. Passwords are the other case
 * entirely and use argon2id (`../users/password.ts`).
 */
import { createHash } from "node:crypto";

/** 256 bits: the same strength as the hash that stores it. */
const TOKEN_BYTES = 32;

/** A fresh token. The plaintext exists only in the response that returns it. */
export const mintToken = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))).toString("base64url");

/** How a token is stored, and how a presented one is looked up: SHA-256, hex. */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
