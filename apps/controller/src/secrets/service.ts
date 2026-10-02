/**
 * The `secret.*` operations.
 *
 * These operations work with references only: an owner, a name and two
 * timestamps. A value is written and never read back out, not by this service,
 * the API or the CLI. Only the code that needs a value to do its job decrypts
 * it, through the repository, in this process.
 *
 * The transport cannot enforce these two rules, so this service does:
 *
 * - **`core` and `connection` are not writable.** A set or delete for either
 *   owner kind fails with `validation` on the `ownerKind` field:
 *   - The `core` owner holds the controller's own key material - its Ed25519
 *     signing key is `core`/`controller.signing-key` - and overwriting it
 *     would break the controller's identity and, with it, every runner's
 *     trust in this controller.
 *   - A Connection's credentials may only be replaced by credentials for the
 *     same account, and only the Connection operations check that. A write
 *     here would skip the check and could quietly move the Connection, with
 *     its triggers and Resources, to another account.
 *
 *   Their references are still listed: hiding a row that exists would be
 *   worse than showing one the API does not let you change.
 * - **An owner id or a name containing `|`** would make the encryption's
 *   associated data ambiguous. The contract's schema rejects it before the
 *   payload is decoded. The repository rejects it again for in-process
 *   callers, and this service converts that error to the same `validation`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  DEFAULT_PAGE_LIMIT,
  createNotFoundError,
  createValidationError,
  type Forbidden,
  type NotFound,
  type OwnerKind,
  type SecretRef,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { requireUserActor, USER_ACTOR } from "../actor";
import { withTransaction, type CursorError } from "../db";
import { AuditLog } from "../events";
import {
  Secrets,
  type SecretNameError,
  type SecretOwner,
  type SecretRef as StoredSecret,
} from "./repository";

/** Which secrets to list, and which page of the list to return. */
export interface SecretQueryInput {
  readonly ownerKind?: OwnerKind;
  readonly ownerId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: { readonly field: "name"; readonly direction?: SortDirection };
}

/** A value to store under an owner and a name. Rotation is the same call. */
export interface SecretSetInput {
  readonly ownerKind: OwnerKind;
  readonly ownerId: string;
  readonly name: string;
  readonly value: string;
}

/** Which stored value to remove. */
export interface SecretDeleteInput {
  readonly ownerKind: OwnerKind;
  readonly ownerId: string;
  readonly name: string;
}

/** One page of references. `nextCursor` is absent on the last page. */
export interface SecretRefPage {
  readonly items: ReadonlyArray<SecretRef>;
  readonly nextCursor?: string;
}

/** The refusal message for each owner kind that `secret.set` and `secret.delete` may not write. */
const REFUSAL_BY_OWNER_KIND: Partial<Record<OwnerKind, string>> = {
  core: "the `core` owner holds the controller's own key material and is not writable through the API",
  connection:
    "a Connection's credentials are not writable through the secret operations, because new credentials must be checked to belong to the same account; replace them with `connection.setCredentials` or by reconnecting the Connection, and remove them by deleting the Connection",
};

/** Succeeds when the API may write secrets of this owner kind, and fails with `validation` when it may not. */
const requireWritableOwnerKind = (ownerKind: OwnerKind): Effect.Effect<void, Validation> => {
  const message = REFUSAL_BY_OWNER_KIND[ownerKind];
  return message === undefined
    ? Effect.void
    : Effect.fail(createValidationError([{ path: ["ownerKind"], message }], message));
};

/** Converts a stored secret to the reference the API returns: no value and no internal row id. */
const toRef = (stored: StoredSecret): SecretRef => ({
  ownerKind: stored.owner.kind,
  ownerId: stored.owner.id,
  name: stored.name,
  createdAt: stored.createdAt,
  ...(stored.rotatedAt === null ? {} : { rotatedAt: stored.rotatedAt }),
});

/** Converts the repository's separator error into a `validation` error. */
const failWithNameIssue = (error: SecretNameError): Effect.Effect<never, Validation> =>
  Effect.fail(
    createValidationError([{ path: [], message: error.message }], "the request is not valid"),
  );

/** Converts a cursor error into a `validation` error on the `cursor` field. */
const failWithCursorIssue = (error: CursorError): Effect.Effect<never, Validation> =>
  Effect.fail(
    createValidationError(
      [{ path: ["cursor"], message: error.message }],
      "the cursor is not valid",
    ),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* Secrets;
  const audit = yield* AuditLog;

  const buildSecretOwner = (input: { ownerKind: OwnerKind; ownerId: string }): SecretOwner => ({
    kind: input.ownerKind,
    id: input.ownerId,
  });

  return {
    /** Returns one page of secret references, sorted by name, ascending by default. */
    query: (
      input: SecretQueryInput,
    ): Effect.Effect<SecretRefPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireUserActor("secret.query");
        const page = yield* secrets.list({
          ownerKind: input.ownerKind,
          ownerId: input.ownerId,
          limit: input.limit ?? DEFAULT_PAGE_LIMIT,
          cursor: input.cursor,
          direction: input.sort?.direction ?? "asc",
        });
        return {
          items: page.items.map(toRef),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
      }).pipe(Effect.catchTag("CursorError", failWithCursorIssue)),

    /**
     * Stores a value, or rotates the value already stored under that name, and
     * returns the reference. A first write returns no `rotatedAt`.
     *
     * The encryption runs inside the transaction. The transaction rule allows
     * that: it is local CPU work through WebCrypto, not a wait on anything
     * outside the database.
     */
    set: (
      input: SecretSetInput,
    ): Effect.Effect<SecretRef, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireUserActor("secret.set");
        yield* requireWritableOwnerKind(input.ownerKind);

        const owner = buildSecretOwner(input);
        const stored = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const written = yield* secrets.set(owner, input.name, Redacted.make(input.value));
            yield* audit.append({
              kind: written.rotatedAt === null ? "secret.created" : "secret.rotated",
              actor: USER_ACTOR,
              // Never put the value here: the Intake views read the audit log,
              // and it is kept for 90 days.
              payload: { ownerKind: owner.kind, ownerId: owner.id, name: input.name },
            });
            return written;
          }),
        );
        return toRef(stored);
      }).pipe(Effect.catchTag("SecretNameError", failWithNameIssue)),

    /** Deletes a stored value. Fails with `not_found` when none exists, instead of a no-op. */
    delete: (
      input: SecretDeleteInput,
    ): Effect.Effect<
      Record<string, never>,
      Unauthenticated | Forbidden | Validation | NotFound | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireUserActor("secret.delete");
        yield* requireWritableOwnerKind(input.ownerKind);

        const owner = buildSecretOwner(input);
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const removed = yield* secrets.delete(owner, input.name);
            if (!removed) {
              return yield* Effect.fail(
                createNotFoundError(`no secret named ${input.name} for ${owner.kind}/${owner.id}`),
              );
            }
            yield* audit.append({
              kind: "secret.deleted",
              actor: USER_ACTOR,
              payload: { ownerKind: owner.kind, ownerId: owner.id, name: input.name },
            });
          }),
        );
        return {};
      }).pipe(Effect.catchTag("SecretNameError", failWithNameIssue)),
  };
});

/** The secret service. */
export class Secret extends Context.Service<Secret, Effect.Success<typeof make>>()(
  "hercule/controller/secrets/Secret",
) {}

export const SecretLayer: Layer.Layer<Secret, never, SqlClient.SqlClient | Secrets | AuditLog> =
  Layer.effect(Secret)(make);
