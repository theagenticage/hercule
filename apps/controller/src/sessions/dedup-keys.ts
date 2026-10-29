/**
 * The dedup keys of `session.spawn`, `session.continue` and `session.input`.
 *
 * An agent that retries one of these calls after a timeout sends the same
 * `dedupKey` again. The first call recorded the key together with the id it
 * returned, so the repeat returns that id and does no work. A key belongs to
 * one actor and one operation: two actors may use the same text, and so may
 * two operations.
 *
 * A call claims its key in the transaction that writes the session or the
 * input. The claim is the check: it fails when the key is already taken, and
 * the failure rolls back everything the call wrote in that transaction.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { OperationId } from "@hercule/contract";
import { currentStamp } from "../actor";
import { uuidFromString, uuidToString } from "../db";

/** The operations that take a `dedupKey`. */
export type DedupOperation = Extract<
  OperationId,
  "session.spawn" | "session.continue" | "session.input"
>;

/**
 * A call tried to claim a dedup key that the same actor already used for the
 * same operation. The caller's transaction must roll back, so the repeat
 * writes nothing; `returnExistingOrCreate` then returns the first call's
 * result.
 */
export class DedupKeyTaken extends Data.TaggedError("DedupKeyTaken")<{
  readonly operation: DedupOperation;
  readonly dedupKey: string;
}> {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Returns the id stored for the key of the current actor, or `undefined` when there is none. */
  const findResultId = (
    operation: DedupOperation,
    dedupKey: string,
  ): Effect.Effect<string | undefined, SqlError> =>
    Effect.gen(function* () {
      const actor = yield* currentStamp;
      const rows = yield* sql<{ readonly result_id: Uint8Array }>`
        SELECT result_id FROM session_dedup_keys
        WHERE actor = ${actor} AND operation = ${operation} AND dedup_key = ${dedupKey}
      `;
      return rows[0] === undefined ? undefined : uuidToString(rows[0].result_id);
    });

  return {
    /**
     * Records that the current actor used `dedupKey` for `operation` and got
     * `resultId` back, in the caller's transaction. Returns nothing. Fails
     * with `DedupKeyTaken` when the actor already used the key for this
     * operation.
     *
     * The failure is the point. Inside the caller's transaction it rolls back
     * everything the repeat call wrote (the session, the workspace, the
     * input, the attachment claims), so a repeat never leaves a row behind.
     * Call it in the same transaction as the write it guards, and never open a
     * transaction of its own around it.
     */
    claimDedupKey: (
      operation: DedupOperation,
      dedupKey: string,
      resultId: string,
    ): Effect.Effect<void, DedupKeyTaken | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* currentStamp;
        const claimed = yield* sql`
          INSERT INTO session_dedup_keys (actor, operation, dedup_key, result_id)
          VALUES (${actor}, ${operation}, ${dedupKey}, ${uuidFromString(resultId)})
          ON CONFLICT (actor, operation, dedup_key) DO NOTHING
          RETURNING dedup_key
        `;
        if (claimed.length === 0) {
          return yield* Effect.fail(new DedupKeyTaken({ operation, dedupKey }));
        }
      }),

    /**
     * Runs `create`, unless the current actor already used `dedupKey` for
     * `operation`. In that case it returns `readExisting` for the id the first
     * call returned, which reads the result as it is now, and never runs
     * `create`. Fails with whatever `readExisting` or `create` fails with, or
     * with `SqlError` when a lookup fails.
     *
     * With no `dedupKey`, it runs `create` and nothing else. `create` cannot
     * fail with `DedupKeyTaken` then, because it claims no key, so this dies
     * if it does.
     *
     * With a key that is not yet recorded, it runs `create`, which claims the
     * key in its own transaction (`claimDedupKey`). It recovers from
     * `DedupKeyTaken` only. That error proves another call with the same key
     * committed its claim first, because the database has one writer at a
     * time: the key is then recorded, and this returns `readExisting` for it.
     * Every other failure, any defect and an interruption pass through
     * unchanged. In particular, a failure after the claim committed (the
     * runner not answering, say) reaches the caller as it is. Turning it
     * into the first result would hide a failure that did happen.
     */
    returnExistingOrCreate: <A, E, R, E2, R2>(
      operation: DedupOperation,
      dedupKey: string | undefined,
      readExisting: (resultId: string) => Effect.Effect<A, E2, R2>,
      create: Effect.Effect<A, E | DedupKeyTaken, R>,
    ): Effect.Effect<A, Exclude<E, DedupKeyTaken> | E2 | SqlError, R | R2> => {
      // The casts below only tell TypeScript what `catchTag` did: it cannot
      // remove `DedupKeyTaken` from an error type that is still generic.
      if (dedupKey === undefined) {
        return Effect.catchTag(create, "DedupKeyTaken", () =>
          Effect.die(`${operation} claimed a dedup key although the caller sent none`),
        ) as Effect.Effect<A, Exclude<E, DedupKeyTaken>, R>;
      }
      const readExistingOrDie = (): Effect.Effect<A, E2 | SqlError, R2> =>
        Effect.flatMap(findResultId(operation, dedupKey), (resultId) =>
          resultId === undefined
            ? Effect.die(
                `${operation} lost the claim of a dedup key that is not recorded: ${dedupKey}`,
              )
            : readExisting(resultId),
        );
      return Effect.flatMap(findResultId(operation, dedupKey), (resultId) =>
        resultId === undefined
          ? (Effect.catchTag(create, "DedupKeyTaken", readExistingOrDie) as Effect.Effect<
              A,
              Exclude<E, DedupKeyTaken> | E2 | SqlError,
              R | R2
            >)
          : readExisting(resultId),
      );
    },
  };
});

export const dedupKeyRepository = make;
