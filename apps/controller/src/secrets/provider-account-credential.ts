/**
 * Decrypts the credential of one Provider Account, for the frame that sends it
 * to the runner that needs it.
 *
 * This is the only place a Provider Account's credential is decrypted. It is
 * read while a frame is built and never stored anywhere else: the plaintext
 * exists in this process only while the frame is built, and then on the wire.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { SqlError } from "effect/sql/SqlError";
import type { SecretDecryptError } from "./cipher";
import { buildProviderAccountOwner, type Secrets } from "./repository";

/**
 * The name a key account's key is stored under. Every key kind has one
 * `credentials` field of this name (spec 06 section 15.2), and the secret
 * migration of an old Z.ai key writes it under the same name.
 */
export const API_KEY_SECRET_NAME = "apiKey";

/**
 * Returns the account's stored key, decrypted, or `none` when the account has
 * none (a per-machine account, or a key account the user has not given a key
 * yet).
 *
 * Fails when the stored value cannot be read or decrypted, and the caller
 * fails with it. A probe or a session that went ahead without the key would
 * report that it is not logged in, which would look as if the user never
 * entered one.
 */
export const readProviderAccountCredential = (
  secrets: Secrets["Service"],
  providerAccountId: string,
): Effect.Effect<Option.Option<string>, SqlError | SecretDecryptError> =>
  secrets.get(buildProviderAccountOwner(providerAccountId), API_KEY_SECRET_NAME).pipe(
    Effect.map(Option.map(Redacted.value)),
    // The name is a constant without `|` and an account id is a UUID, so the
    // secrets store can never reject either.
    Effect.catchTag("SecretNameError", Effect.die),
  );
