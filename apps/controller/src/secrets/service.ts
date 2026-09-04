/**
 * The `secret.*` operations (spec 11 section 2, spec 13 section 2).
 *
 * Everything here is a reference: an owner, a name and two timestamps. A value
 * goes in and is never read back out - not by this service, not by the API, not
 * by the CLI (spec 13 section 2.5). The only code that decrypts is whatever
 * needs the value to do its job, through the repository, in this process.
 *
 * Two rules the transport cannot enforce, so they live here:
 *
 * - **`core` is not writable.** The `core` owner holds the controller's own key
 *   material - its Ed25519 signing key is `core`/`controller.signing-key` - and
 *   overwriting it would break controller identity and, with it, every runner's
 *   trust in this controller (spec 13 section 1, ADR 0005). Nothing in the spec
 *   forbade it, so this refuses it: `validation`, naming the field. It stays
 *   *readable* as a reference: hiding a row that exists would be a worse answer
 *   than showing one the API declines to change.
 * - **An owner id or a name holding `|`** would make the encryption's
 *   associated data ambiguous. The contract's schema rejects one before the
 *   payload is decoded; the repository rejects it again for the in-process
 *   caller, and that rejection is mapped to the same `validation` here.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  DEFAULT_PAGE_LIMIT,
  notFound,
  validation,
  type Forbidden,
  type NotFound,
  type OwnerKind,
  type SecretRef,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { currentUser, USER_ACTOR } from "../actor";
import { withTransaction, type CursorError } from "../db";
import { AuditLog } from "../events";
import {
  Secrets,
  type SecretNameError,
  type SecretOwner,
  type SecretRef as StoredSecret,
} from "./repository";

/** Which secrets to list, and how much of the listing to hand back. */
export interface SecretQueryInput {
  readonly ownerKind?: OwnerKind;
  readonly ownerId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: { readonly field: "name"; readonly direction: SortDirection };
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

/** Why `core` is refused, in the words the caller reads. */
const CORE_REFUSED =
  "the `core` owner holds the controller's own key material and is not writable through the API";

const coreRefused = (): Validation =>
  validation([{ path: ["ownerKind"], message: CORE_REFUSED }], CORE_REFUSED);

/** What the wire sees: everything but the value, and no internal row id. */
const toRef = (stored: StoredSecret): SecretRef => ({
  ownerKind: stored.owner.kind,
  ownerId: stored.owner.id,
  name: stored.name,
  createdAt: stored.createdAt,
  ...(stored.rotatedAt === null ? {} : { rotatedAt: stored.rotatedAt }),
});

/** A separator the repository refused, in the envelope's vocabulary. */
const nameIssue = (error: SecretNameError): Effect.Effect<never, Validation> =>
  Effect.fail(validation([{ path: [], message: error.message }], "the request is not valid"));

/** A cursor this listing did not issue, in the envelope's vocabulary. */
const cursorIssue = (error: CursorError): Effect.Effect<never, Validation> =>
  Effect.fail(
    validation([{ path: ["cursor"], message: error.message }], "the cursor is not valid"),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* Secrets;
  const audit = yield* AuditLog;

  const ownerOf = (input: { ownerKind: OwnerKind; ownerId: string }): SecretOwner => ({
    kind: input.ownerKind,
    id: input.ownerId,
  });

  return {
    /** The references a caller may see, by name, oldest name first by default. */
    query: (
      input: SecretQueryInput,
    ): Effect.Effect<SecretRefPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* currentUser("secret.query");
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
      }).pipe(Effect.catchTag("CursorError", cursorIssue)),

    /**
     * Stores a value, or rotates the one already there. Which of the two it was
     * is what the row came back with: a first write has no `rotatedAt`.
     *
     * The encryption happens inside the transaction. It is local CPU work
     * through WebCrypto, not a wait on anything outside the database, which is
     * the line the ambient-transaction rule draws (ADR 0004).
     */
    set: (
      input: SecretSetInput,
    ): Effect.Effect<SecretRef, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* currentUser("secret.set");
        if (input.ownerKind === "core") return yield* Effect.fail(coreRefused());

        const owner = ownerOf(input);
        const stored = yield* withTransaction(
          Effect.gen(function* () {
            const written = yield* secrets.set(owner, input.name, Redacted.make(input.value));
            yield* audit.append({
              kind: written.rotatedAt === null ? "secret.created" : "secret.rotated",
              actor: USER_ACTOR,
              // The value is not here and never will be: the log is read by the
              // Intake views and kept for 90 days (spec 13 section 11).
              payload: { ownerKind: owner.kind, ownerId: owner.id, name: input.name },
            });
            return written;
          }),
        );
        return toRef(stored);
      }).pipe(
        Effect.catchTag("SecretNameError", nameIssue),
        Effect.provideService(SqlClient.SqlClient, sql),
      ),

    /** Removes a stored value. A name nobody stored is `not_found`, not a no-op. */
    delete: (
      input: SecretDeleteInput,
    ): Effect.Effect<
      Record<string, never>,
      Unauthenticated | Forbidden | Validation | NotFound | SqlError
    > =>
      Effect.gen(function* () {
        yield* currentUser("secret.delete");
        if (input.ownerKind === "core") return yield* Effect.fail(coreRefused());

        const owner = ownerOf(input);
        yield* withTransaction(
          Effect.gen(function* () {
            const removed = yield* secrets.delete(owner, input.name);
            if (!removed) {
              return yield* Effect.fail(
                notFound(`no secret named ${input.name} for ${owner.kind}/${owner.id}`),
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
      }).pipe(
        Effect.catchTag("SecretNameError", nameIssue),
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
  };
});

/** The secret service (ADR 0031: every operation is a method on an Effect service). */
export class Secret extends Context.Service<Secret, Effect.Success<typeof make>>()(
  "hydra/controller/secrets/Secret",
) {}

export const SecretLayer: Layer.Layer<Secret, never, SqlClient.SqlClient | Secrets | AuditLog> =
  Layer.effect(Secret)(make);
