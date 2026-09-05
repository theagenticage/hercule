/**
 * The controller's persistent identity: an id plus key material, created at
 * install and carried through a promotion.
 *
 * Identity is logical, not an address. Runners verify it wherever the
 * controller appears, which is what makes a "controller moved to X"
 * announcement unspoofable and lets a promoted controller resume the same
 * runner sessions.
 *
 * The keypair is Ed25519: small signatures, no parameter choices to get wrong,
 * and already in Bun's WebCrypto. The public key sits in the singleton
 * `controller_identity` row as raw SPKI bytes; the private key is a secrets row
 * under the `core` owner, encrypted under the Master Key
 * like every other secret, so a stolen database file yields nothing.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { mintUuid, nowIso, uuidToString, withTransaction } from "../db";
import { CORE_OWNER, Secrets, type SecretNameError } from "../secrets";

/** The `core`-owned secret holding the controller's Ed25519 private key, PKCS#8 as base64. */
export const SIGNING_KEY_SECRET = "controller.signing-key";

/** What the controller tells a runner about itself. Never the private key. */
export interface ControllerIdentityRecord {
  readonly id: string;
  /** The Ed25519 public key, raw SPKI bytes. */
  readonly publicKey: Uint8Array<ArrayBuffer>;
  readonly createdAt: string;
}

/** The algorithm the identity keypair is made, signed and verified under. */
const ED25519 = { name: "Ed25519" } as const;

/**
 * The bytes base64 stands for, in the buffer WebCrypto's types ask for: a
 * `Buffer` is backed by a pool it shares, which is a `SharedArrayBuffer` as far
 * as the DOM types are concerned. Exported because the socket decodes the nonce
 * it hands to `sign` the same way.
 */
export const asBytes = (encoded: string): Uint8Array<ArrayBuffer> => {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
};

/**
 * Ed25519 is not in the DOM's `generateKey` overloads, which resolve to a
 * single `CryptoKey`; every Ed25519 generation returns a pair.
 */
const generateSigningKeyPair = Effect.promise(
  () =>
    crypto.subtle.generateKey(ED25519, true, [
      "sign",
      "verify",
    ]) as unknown as Promise<CryptoKeyPair>,
);

/** The controller's own identity. */
export class ControllerIdentity extends Context.Service<
  ControllerIdentity,
  {
    /**
     * The identity, creating it on first run. Idempotent: every later boot
     * finds the same id and the same key.
     */
    readonly ensure: Effect.Effect<ControllerIdentityRecord, SqlError | SecretNameError>;

    /**
     * The identity as it stands, without creating one. `None` only before the
     * first boot has run: every caller after that has one.
     */
    readonly read: Effect.Effect<Option.Option<ControllerIdentityRecord>, SqlError>;

    /**
     * Signs bytes with the identity's private key, which is how the controller
     * proves to a runner that the address it dialled is the controller that
     * enlisted it. The key never leaves this service.
     */
    readonly sign: (
      payload: Uint8Array<ArrayBuffer>,
    ) => Effect.Effect<Uint8Array<ArrayBuffer>, SqlError | SecretNameError>;
  }
>()("hydra/controller/identity/ControllerIdentity") {}

export const controllerIdentityLayer: Layer.Layer<
  ControllerIdentity,
  never,
  Secrets | SqlClient.SqlClient
> = Layer.effect(
  ControllerIdentity,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secrets = yield* Secrets;

    const signingKey = Effect.gen(function* () {
      const stored = yield* secrets.get(CORE_OWNER, SIGNING_KEY_SECRET).pipe(
        // A value this build cannot decrypt is the same situation as one that
        // is not there: there is no key to sign with either way.
        Effect.catchTag("SecretDecryptError", () => Effect.succeedNone),
      );
      // `ensure` writes the key with the identity row in one transaction and
      // the boot runs it before anything binds, so a controller with an
      // identity and no key it can read is a home somebody assembled by hand.
      if (Option.isNone(stored)) {
        return yield* Effect.die("the controller's signing key cannot be read");
      }
      return yield* Effect.promise(() =>
        crypto.subtle.importKey("pkcs8", asBytes(Redacted.value(stored.value)), ED25519, false, [
          "sign",
        ]),
      );
    });

    const read = sql<{
      readonly id: Uint8Array<ArrayBuffer>;
      readonly public_key: Uint8Array<ArrayBuffer>;
      readonly created_at: string;
    }>`SELECT id, public_key, created_at FROM controller_identity WHERE singleton = 1`.pipe(
      Effect.map((rows) => {
        const row = rows[0];
        return row === undefined
          ? Option.none<ControllerIdentityRecord>()
          : Option.some({
              id: uuidToString(row.id),
              publicKey: row.public_key,
              createdAt: row.created_at,
            });
      }),
    );

    return ControllerIdentity.of({
      read,

      sign: (payload) =>
        Effect.gen(function* () {
          const key = yield* signingKey;
          return new Uint8Array(
            yield* Effect.promise(() => crypto.subtle.sign(ED25519, key, payload)),
          );
        }),

      // One transaction: the identity row and the private key it belongs to are
      // written together or not at all. Generating the keypair is local CPU
      // work, not a wait on anything outside the database.
      ensure: withTransaction(
        sql,
        Effect.gen(function* () {
          const existing = yield* read;
          if (Option.isSome(existing)) return existing.value;

          const pair = yield* generateSigningKeyPair;
          const publicKey = new Uint8Array(
            yield* Effect.promise(() => crypto.subtle.exportKey("spki", pair.publicKey)),
          );
          const privateKey = new Uint8Array(
            yield* Effect.promise(() => crypto.subtle.exportKey("pkcs8", pair.privateKey)),
          );

          yield* secrets.set(
            CORE_OWNER,
            SIGNING_KEY_SECRET,
            Redacted.make(Buffer.from(privateKey).toString("base64")),
          );

          const id = mintUuid();
          const createdAt = yield* nowIso;
          yield* sql`
            INSERT INTO controller_identity (singleton, id, public_key, created_at)
            VALUES (1, ${id}, ${publicKey}, ${createdAt})
          `;
          return { id: uuidToString(id), publicKey, createdAt };
        }),
      ),
    });
  }),
);
