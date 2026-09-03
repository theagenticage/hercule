/**
 * The one owner-scoped secrets table (spec 04, Secrets table; spec 13 section
 * 2.1; ADR 0015).
 *
 * Every secret value - Connection credentials, plugin secrets, runner-scoped
 * secrets, provider-instance credentials, the controller's own key material -
 * is one row, encrypted on its own under the Master Key. The SQLite file stays
 * plain, so any copy of it, any backup and any promotion bundle is inert
 * without the key.
 *
 * Cipher: AES-256-GCM through WebCrypto, a fresh 12-byte random nonce for every
 * write, and the row's owner and name as associated data, formatted
 * `<kind>|<id>|<name>`. Two consequences worth stating:
 *
 * - **A rename is a re-encrypt.** Moving a value to another owner or name means
 *   {@link Secrets.set} under the new key, never an `UPDATE` of `name` alone.
 *   A row edited that way stops decrypting, which is the point: it makes a
 *   row swapped in from another owner detectable rather than silently readable.
 * - **Owner ids and names carry no `|`**, so the associated data has exactly
 *   one reading. Both calls reject the character rather than trusting their
 *   callers; plugin-supplied names reach this table (spec 13 section 2.4).
 *
 * The associated data binds a value to its owner and name, not to a version: a
 * row rolled back to its own earlier ciphertext still decrypts. Detecting that
 * needs a monotonic counter in the row, and an attacker who can write the
 * database file is outside the threat model of spec 13 section 1.
 *
 * Plaintext exists only in this process, only for the length of a call, and
 * only inside a {@link Redacted.Redacted}: it never appears in the event log,
 * an API response, a Notification, a process log, or the web app (spec 13
 * section 2.5).
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { mintUuid, uuidToString } from "../db";
import { MasterKey } from "./masterKey";

/** Who a secret belongs to (spec 13 section 2.1). */
export type SecretOwnerKind = "connection" | "plugin" | "runner" | "core" | "provider-instance";

/**
 * The owning entity: its kind, and its canonical id string. `core` has no
 * entity, so it uses a fixed name - see {@link CORE_OWNER}.
 */
export interface SecretOwner {
  readonly kind: SecretOwnerKind;
  readonly id: string;
}

/** The owner of the controller's own key material (spec 13 section 2.1, "Core"). */
export const CORE_OWNER: SecretOwner = { kind: "core", id: "controller" };

/**
 * What the rest of the system may know about a secret: that it exists, who owns
 * it, and when it was last rotated. Never the value (spec 13 section 2.5).
 */
export interface SecretRef {
  readonly id: string;
  readonly owner: SecretOwner;
  readonly name: string;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
}

/** An owner id or secret name that would make the associated data ambiguous. */
export class SecretNameError extends Schema.TaggedError<SecretNameError>()("SecretNameError", {
  message: Schema.String,
}) {}

/**
 * A stored value did not decrypt. Either the Master Key is not the one the row
 * was written under, or the row's owner, name, nonce or ciphertext was edited
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
type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** AES-GCM's nonce size; the only one it is specified for. */
const NONCE_BYTES = 12;

const associatedData = (owner: SecretOwner, name: string): Bytes =>
  encoder.encode(`${owner.kind}|${owner.id}|${name}`);

/** The associated data has exactly one reading only while nothing in it holds the separator. */
const rejectSeparator = (owner: SecretOwner, name: string): Effect.Effect<void, SecretNameError> =>
  Effect.gen(function* () {
    for (const [what, text] of [
      ["owner id", owner.id],
      ["name", name],
    ] as const) {
      if (text.includes("|")) {
        return yield* new SecretNameError({
          message:
            `A secret's ${what} cannot contain "|": it is the separator in the ` +
            `associated data that binds a value to its owner. Got ${JSON.stringify(text)}.`,
        });
      }
    }
  });

/** The secrets table (spec 04, Secrets table). */
export class Secrets extends Context.Service<
  Secrets,
  {
    /**
     * Writes a value, replacing any value the owner already stores under this
     * name. That replacement is rotation: the row keeps its id and its
     * `createdAt`, gets a fresh nonce and ciphertext, and is stamped
     * `rotatedAt`.
     */
    readonly set: (
      owner: SecretOwner,
      name: string,
      value: Redacted.Redacted<string>,
    ) => Effect.Effect<SecretRef, SqlError | SecretNameError>;

    /** The stored value, or `None` when this owner stores nothing under this name. */
    readonly get: (
      owner: SecretOwner,
      name: string,
    ) => Effect.Effect<
      Option.Option<Redacted.Redacted<string>>,
      SqlError | SecretNameError | SecretDecryptError
    >;
  }
>()("hydra/controller/secrets/Secrets") {}

/**
 * The secrets repository over the controller database, encrypting under the
 * Master Key. Its queries join whatever transaction the caller opened, like
 * every other repository (ADR 0031).
 */
export const secretsLayer: Layer.Layer<Secrets, never, MasterKey | SqlClient.SqlClient> =
  Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { key } = yield* MasterKey;

      const decryptFailed = (owner: SecretOwner, name: string) =>
        new SecretDecryptError({
          ownerKind: owner.kind,
          ownerId: owner.id,
          name,
          message:
            `The secret ${owner.kind}/${owner.id}/${name} did not decrypt under this machine's ` +
            `master key. Either the key is not the one it was written under, or the row was ` +
            `edited outside Hydra.`,
        });

      // AES-GCM with a valid key and a 12-byte nonce has no failure mode, so a
      // rejection here is a defect, not an error the caller can act on.
      const encrypt = (owner: SecretOwner, name: string, plaintext: string) =>
        Effect.gen(function* () {
          const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
          const ciphertext = yield* Effect.promise(() =>
            crypto.subtle.encrypt(
              { name: "AES-GCM", iv: nonce, additionalData: associatedData(owner, name) },
              key,
              encoder.encode(plaintext),
            ),
          );
          return { nonce, ciphertext: new Uint8Array(ciphertext) };
        });

      const decrypt = (owner: SecretOwner, name: string, nonce: Bytes, ciphertext: Bytes) =>
        Effect.tryPromise({
          try: () =>
            crypto.subtle.decrypt(
              { name: "AES-GCM", iv: nonce, additionalData: associatedData(owner, name) },
              key,
              ciphertext,
            ),
          catch: () => decryptFailed(owner, name),
        }).pipe(Effect.map((plaintext) => decoder.decode(new Uint8Array(plaintext))));

      return Secrets.of({
        set: (owner, name, value) =>
          Effect.gen(function* () {
            yield* rejectSeparator(owner, name);
            const { nonce, ciphertext } = yield* encrypt(owner, name, Redacted.value(value));
            const now = new Date(yield* Clock.currentTimeMillis).toISOString();
            const rows = yield* sql<{
              readonly id: Bytes;
              readonly created_at: string;
              readonly rotated_at: string | null;
            }>`
              INSERT INTO secrets
                (id, owner_kind, owner_id, name, nonce, ciphertext, created_at, rotated_at)
              VALUES
                (${mintUuid()}, ${owner.kind}, ${owner.id}, ${name}, ${nonce}, ${ciphertext},
                 ${now}, ${null})
              ON CONFLICT (owner_kind, owner_id, name) DO UPDATE SET
                nonce = excluded.nonce,
                ciphertext = excluded.ciphertext,
                -- excluded.created_at is this write's timestamp, not the
                -- stored row's: rotating stamps rotated_at and leaves
                -- created_at as it was.
                rotated_at = excluded.created_at
              RETURNING id, created_at, rotated_at
            `;
            const row = rows[0]!;
            return {
              id: uuidToString(row.id),
              owner,
              name,
              createdAt: row.created_at,
              rotatedAt: row.rotated_at,
            };
          }),

        get: (owner, name) =>
          Effect.gen(function* () {
            yield* rejectSeparator(owner, name);
            const rows = yield* sql<{
              readonly nonce: Bytes;
              readonly ciphertext: Bytes;
            }>`
              SELECT nonce, ciphertext FROM secrets
              WHERE owner_kind = ${owner.kind} AND owner_id = ${owner.id} AND name = ${name}
            `;
            const row = rows[0];
            if (row === undefined) return Option.none();
            const plaintext = yield* decrypt(owner, name, row.nonce, row.ciphertext);
            return Option.some(Redacted.make(plaintext));
          }),
      });
    }),
  );
