/**
 * The cipher every secret value is stored under: AES-256-GCM through
 * WebCrypto, a fresh 12-byte random nonce for every write, and the owner and
 * name as associated data, formatted `<kind>|<id>|<name>`. The repository
 * explains why the associated data binds a value to its owner.
 *
 * The key is a parameter, so the same cipher serves the Master Key and the
 * transfer key a promotion re-encrypts under.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SecretOwner } from "./repository";

/**
 * A stored value did not decrypt. Either the key is not the one the row was
 * written under, or the row's owner, name, nonce or ciphertext was edited
 * behind the repository's back. Carries no value and no cause.
 */
export class SecretDecryptError extends Schema.TaggedError<SecretDecryptError>()(
  "SecretDecryptError",
  {
    ownerKind: Schema.String,
    ownerId: Schema.String,
    name: Schema.String,
    message: Schema.String,
  },
) {}

/** Plain bytes, not a view on a `SharedArrayBuffer`: what WebCrypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** One encrypted value, as a secrets row stores it. */
export interface EncryptedValue {
  readonly nonce: Bytes;
  readonly ciphertext: Bytes;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** AES-GCM's nonce size; the only one it is specified for. */
const NONCE_BYTES = 12;

const buildAssociatedData = (owner: SecretOwner, name: string): Bytes =>
  encoder.encode(`${owner.kind}|${owner.id}|${name}`);

/**
 * Encrypts `plaintext` under `key` for this owner and name, with a fresh
 * nonce. AES-GCM with a valid key and a 12-byte nonce has no failure mode, so
 * a rejection is a defect, not an error the caller can act on.
 */
export const encryptSecretValue = (
  key: CryptoKey,
  owner: SecretOwner,
  name: string,
  plaintext: string,
): Effect.Effect<EncryptedValue> =>
  Effect.gen(function* () {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const ciphertext = yield* Effect.promise(() =>
      crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: buildAssociatedData(owner, name) },
        key,
        encoder.encode(plaintext),
      ),
    );
    return { nonce, ciphertext: new Uint8Array(ciphertext) };
  });

/**
 * Decrypts a value stored for this owner and name under `key`. Fails with
 * `SecretDecryptError` when the key, the owner, the name or the bytes are
 * not the ones it was written with.
 */
export const decryptSecretValue = (
  key: CryptoKey,
  owner: SecretOwner,
  name: string,
  stored: EncryptedValue,
): Effect.Effect<string, SecretDecryptError> =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.decrypt(
        { name: "AES-GCM", iv: stored.nonce, additionalData: buildAssociatedData(owner, name) },
        key,
        stored.ciphertext,
      ),
    catch: () =>
      new SecretDecryptError({
        ownerKind: owner.kind,
        ownerId: owner.id,
        name,
        message:
          `The secret ${owner.kind}/${owner.id}/${name} did not decrypt. Either the key is not ` +
          `the one it was written under, or the row was edited outside Hercule.`,
      }),
  }).pipe(Effect.map((plaintext) => decoder.decode(new Uint8Array(plaintext))));
