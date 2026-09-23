/**
 * The one owner-scoped secrets table.
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
 *   callers; plugin-supplied names reach this table.
 *
 * The associated data binds a value to its owner and name, not to a version: a
 * row rolled back to its own earlier ciphertext still decrypts. Detecting that
 * needs a monotonic counter in the row, and an attacker who can write the
 * database file is outside the threat model.
 *
 * Plaintext exists only in this process, only for the length of a call, and
 * only inside a {@link Redacted.Redacted}: it never appears in the event log,
 * an API response, a Notification, a process log, or the web app.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  decodeCursor,
  encodeCursor,
  buildKeyset,
  mintUuid,
  nowIso,
  buildPage,
  uuidFromString,
  uuidToString,
  type CursorError,
  type Page,
  type CursorScope,
  type PageRequest,
} from "../db";
import { MasterKey } from "./masterKey";

/** Who a secret belongs to. */
export type SecretOwnerKind = "connection" | "plugin" | "runner" | "core" | "provider-instance";

/**
 * The owning entity: its kind, and its canonical id string. `core` has no
 * entity, so it uses a fixed name - see {@link CORE_OWNER}.
 */
export interface SecretOwner {
  readonly kind: SecretOwnerKind;
  readonly id: string;
}

/** The owner of the controller's own key material. */
export const CORE_OWNER: SecretOwner = { kind: "core", id: "controller" };

/** The owner a provider instance's credentials are written and read under. */
export const buildProviderInstanceOwner = (instanceId: string): SecretOwner => ({
  kind: "provider-instance",
  id: instanceId,
});

/**
 * What the rest of the system may know about a secret: that it exists, who owns
 * it, and when it was last rotated. Never the value.
 */
export interface SecretRef {
  readonly id: string;
  readonly owner: SecretOwner;
  readonly name: string;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
}

/** One stored secret as its owner lists it: the name, and when it was replaced. */
export interface SecretNameRef {
  readonly name: string;
  readonly rotatedAt: string | null;
}

/** What a listing asks for: which owner, plus the shared keyset parameters. */
export interface SecretListRequest extends PageRequest {
  readonly ownerKind: SecretOwnerKind | undefined;
  readonly ownerId: string | undefined;
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

const buildAssociatedData = (owner: SecretOwner, name: string): Bytes =>
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

/** The secrets table. */
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

    /**
     * The references one owner - or every owner - stores, by name. References
     * only: nothing here decrypts, because nothing outside the repository may
     * see a value.
     */
    readonly list: (
      request: SecretListRequest,
    ) => Effect.Effect<Page<SecretRef>, SqlError | CursorError>;

    /** Removes a stored value, and answers whether there was one to remove. */
    readonly delete: (
      owner: SecretOwner,
      name: string,
    ) => Effect.Effect<boolean, SqlError | SecretNameError>;

    /**
     * The references these owners store, by name, grouped by owner id: what an
     * owning record hands out as its own credential list. Many owners at once,
     * because the caller is usually a page of records and one query is what
     * keeps it one query. The whole list rather than a page, because its caller
     * is a scoped view over one owner rather than a listing anyone browses.
     */
    readonly refs: (
      kind: SecretOwnerKind,
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<SecretNameRef>>, SqlError>;

    /**
     * Everything one owner stores, decrypted, in one query. The only batch read
     * that decrypts, and it exists because a plugin asks for a connection's
     * credentials as a whole rather than field by field.
     */
    readonly values: (
      owner: SecretOwner,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly name: string; readonly value: Redacted.Redacted<string> }>,
      SqlError | SecretDecryptError
    >;

    /** The stored value, or `None` when this owner stores nothing under this name. */
    readonly get: (
      owner: SecretOwner,
      name: string,
    ) => Effect.Effect<
      Option.Option<Redacted.Redacted<string>>,
      SqlError | SecretNameError | SecretDecryptError
    >;
  }
>()("hercule/controller/secrets/Secrets") {}

/**
 * The secrets repository over the controller database, encrypting under the
 * Master Key. Its queries join whatever transaction the caller opened, like
 * every other repository.
 */
export const secretsLayer: Layer.Layer<Secrets, never, MasterKey | SqlClient.SqlClient> =
  Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { key } = yield* MasterKey;

      const createDecryptError = (owner: SecretOwner, name: string) =>
        new SecretDecryptError({
          ownerKind: owner.kind,
          ownerId: owner.id,
          name,
          message:
            `The secret ${owner.kind}/${owner.id}/${name} did not decrypt under this machine's ` +
            `master key. Either the key is not the one it was written under, or the row was ` +
            `edited outside Hercule.`,
        });

      // AES-GCM with a valid key and a 12-byte nonce has no failure mode, so a
      // rejection here is a defect, not an error the caller can act on.
      const encrypt = (owner: SecretOwner, name: string, plaintext: string) =>
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

      const decrypt = (owner: SecretOwner, name: string, nonce: Bytes, ciphertext: Bytes) =>
        Effect.tryPromise({
          try: () =>
            crypto.subtle.decrypt(
              { name: "AES-GCM", iv: nonce, additionalData: buildAssociatedData(owner, name) },
              key,
              ciphertext,
            ),
          catch: () => createDecryptError(owner, name),
        }).pipe(Effect.map((plaintext) => decoder.decode(new Uint8Array(plaintext))));

      return Secrets.of({
        set: (owner, name, value) =>
          Effect.gen(function* () {
            yield* rejectSeparator(owner, name);
            const { nonce, ciphertext } = yield* encrypt(owner, name, Redacted.value(value));
            const now = yield* nowIso;
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

        refs: (kind, ids) =>
          ids.length === 0
            ? Effect.succeed(new Map())
            : sql<{
                readonly owner_id: string;
                readonly name: string;
                readonly rotated_at: string | null;
              }>`
                SELECT owner_id, name, rotated_at FROM secrets
                WHERE owner_kind = ${kind} AND owner_id IN ${sql.in(ids)}
                ORDER BY owner_id, name
              `.pipe(
                Effect.map((rows) => {
                  const grouped = new Map<string, Array<SecretNameRef>>();
                  for (const row of rows) {
                    const held = grouped.get(row.owner_id) ?? [];
                    held.push({ name: row.name, rotatedAt: row.rotated_at });
                    grouped.set(row.owner_id, held);
                  }
                  return grouped;
                }),
              ),

        values: (owner) =>
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly name: string;
              readonly nonce: Bytes;
              readonly ciphertext: Bytes;
            }>`
              SELECT name, nonce, ciphertext FROM secrets
              WHERE owner_kind = ${owner.kind} AND owner_id = ${owner.id}
              ORDER BY name
            `;
            return yield* Effect.forEach(rows, (row) =>
              Effect.map(decrypt(owner, row.name, row.nonce, row.ciphertext), (plaintext) => ({
                name: row.name,
                value: Redacted.make(plaintext),
              })),
            );
          }),

        list: (request) =>
          Effect.gen(function* () {
            const scope: CursorScope = {
              op: "secret.query",
              field: "name",
              direction: request.direction,
            };
            const after =
              request.cursor === undefined
                ? undefined
                : yield* decodeCursor(request.cursor, scope, "string");
            const byKind =
              request.ownerKind === undefined ? sql`` : sql`AND owner_kind = ${request.ownerKind}`;
            const byId =
              request.ownerId === undefined ? sql`` : sql`AND owner_id = ${request.ownerId}`;
            // `(name, id)` rather than name alone: names repeat across owners
            // and an id does not, so a page boundary is unambiguous.
            const { keyset, order } = buildKeyset(
              sql,
              ["name", "id"],
              after === undefined ? undefined : [after[0], uuidFromString(after[1])],
              request.direction,
            );
            const rows = yield* sql<{
              readonly id: Bytes;
              readonly owner_kind: SecretOwnerKind;
              readonly owner_id: string;
              readonly name: string;
              readonly created_at: string;
              readonly rotated_at: string | null;
            }>`
              SELECT id, owner_kind, owner_id, name, created_at, rotated_at
              FROM secrets
              WHERE 1 = 1 ${byKind} ${byId} AND ${keyset}
              ${order} LIMIT ${request.limit + 1}
            `;
            return yield* buildPage(
              rows,
              request.limit,
              (read) =>
                Effect.succeed(
                  read.map((row): SecretRef => ({
                    id: uuidToString(row.id),
                    owner: { kind: row.owner_kind, id: row.owner_id },
                    name: row.name,
                    createdAt: row.created_at,
                    rotatedAt: row.rotated_at,
                  })),
                ),
              (last) => encodeCursor(scope, last.name, last.id),
            );
          }),

        delete: (owner, name) =>
          Effect.gen(function* () {
            yield* rejectSeparator(owner, name);
            const removed = yield* sql<{ readonly id: Bytes }>`
              DELETE FROM secrets
              WHERE owner_kind = ${owner.kind} AND owner_id = ${owner.id} AND name = ${name}
              RETURNING id
            `;
            return removed.length > 0;
          }),
      });
    }),
  );
