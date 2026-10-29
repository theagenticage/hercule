/**
 * The dedup keys of `session.spawn`, `session.continue` and `session.input`.
 *
 * An agent that retries one of these calls after a timeout sends the same
 * `dedupKey` again. The first call recorded the key together with the id it
 * returned, so the repeat returns that id and does no work. A key belongs to
 * one actor and one operation. Two actors may use the same text. So may two
 * operations.
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
 * same operation. The failure rolls back the caller's transaction, so the
 * repeat writes nothing. `returnExistingOrCreate` then returns the result of
 * the call that claimed the key first.
 */
export class DedupKeyTaken extends Data.TaggedError("DedupKeyTaken")<{
  readonly operation: DedupOperation;
  readonly dedupKey: string;
}> {}

/**
 * Claims the call's dedup key for `resultId` in the caller's transaction.
 * Fails with `DedupKeyTaken` when the key is taken, which rolls back
 * everything the call wrote in that transaction.
 */
export type DedupClaim = (resultId: string) => Effect.Effect<void, DedupKeyTaken | SqlError>;

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

  /** Records the key for `resultId`. Fails with `DedupKeyTaken` when the key is already recorded. */
  const insertDedupKey = (
    operation: DedupOperation,
    dedupKey: string,
    resultId: string,
  ): Effect.Effect<void, DedupKeyTaken | SqlError> =>
    Effect.gen(function* () {
      const actor = yield* currentStamp;
      const inserted = yield* sql`
        INSERT INTO session_dedup_keys (actor, operation, dedup_key, result_id)
        VALUES (${actor}, ${operation}, ${dedupKey}, ${uuidFromString(resultId)})
        ON CONFLICT (actor, operation, dedup_key) DO NOTHING
        RETURNING dedup_key
      `;
      if (inserted.length === 0) {
        return yield* Effect.fail(new DedupKeyTaken({ operation, dedupKey }));
      }
    });

  return {
    /**
     * Returns the result of an earlier call with the same `dedupKey`, or
     * runs `create` to make a new result. `operation` and the current actor
     * scope the key. `readExisting` reads the result for the id the earlier
     * call returned, as it is now. Fails with whatever `readExisting` or
     * `create` fails with, or with `SqlError` when a lookup fails.
     *
     * - With no `dedupKey`, this runs `create(undefined)` and nothing else.
     *   It cannot fail with `DedupKeyTaken` then, so this dies if it does.
     * - With a key that is already recorded, this returns `readExisting` for
     *   the recorded id and never runs `create`.
     * - With a key that is not recorded, this runs `create` with a `claim`.
     *   `create` calls `claim(resultId)` inside the transaction that writes
     *   its result. The claim records the key, or fails with `DedupKeyTaken`
     *   when another call recorded it first.
     *
     * When `create` fails with a typed error, this looks the key up again and
     * compares the recorded id with the id this call claimed itself:
     *
     * - Recorded, and not this call's own id: another call with the key
     *   committed first. This returns `readExisting` for its id, whatever the
     *   error was. A call that fails before it claims (it names another
     *   target, say, or something is not found) still returns the winner,
     *   because the rest of a repeated call is not compared with the first.
     * - Nothing recorded, or this call's own id: the failure is this call's
     *   own, for instance the runner not answering after the claim
     *   committed. It reaches the caller unchanged, so a failure that did
     *   happen is never hidden. If that failure is `DedupKeyTaken` with
     *   nothing recorded, the claim lost to a row that does not exist, so
     *   this dies.
     *
     * A failure of the second lookup itself returns the original error.
     * Defects and interruption pass through untouched.
     *
     * Comparing after the fact is safe because the database has one writer
     * at a time: when the second lookup finds a key, the call that recorded
     * it has committed.
     */
    returnExistingOrCreate: <A, E, R, E2, R2>(
      operation: DedupOperation,
      dedupKey: string | undefined,
      readExisting: (resultId: string) => Effect.Effect<A, E2, R2>,
      create: (claim: DedupClaim | undefined) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, Exclude<E, DedupKeyTaken> | E2 | SqlError, R | R2> => {
      // The casts below only tell TypeScript that `DedupKeyTaken` is gone
      // from the error type. It cannot work that out while `E` is generic.
      if (dedupKey === undefined) {
        return Effect.catch(create(undefined), (error: E) =>
          error instanceof DedupKeyTaken
            ? Effect.die(`${operation} claimed a dedup key although the caller sent none`)
            : Effect.fail(error),
        ) as Effect.Effect<A, Exclude<E, DedupKeyTaken>, R>;
      }
      const key = dedupKey;

      /** Runs `create` once. The id this run claimed is local to the run, so the returned effect can run again or at the same time as itself. */
      const createOnce = Effect.suspend(() => {
        let claimedId: string | undefined;
        const claim: DedupClaim = (resultId) =>
          Effect.tap(insertDedupKey(operation, key, resultId), () =>
            Effect.sync(() => {
              claimedId = resultId;
            }),
          );
        return Effect.catch(create(claim), (error: E) =>
          Effect.flatMap(
            // If this lookup fails, the original error is the one to report.
            Effect.catch(findResultId(operation, key), () => Effect.fail(error)),
            (recordedId): Effect.Effect<A, E | E2, R2> => {
              if (recordedId !== undefined && recordedId !== claimedId) {
                return readExisting(recordedId);
              }
              if (recordedId === undefined && error instanceof DedupKeyTaken) {
                return Effect.die(
                  `${operation} lost the claim of a dedup key that is not recorded: ${key}`,
                );
              }
              return Effect.fail(error);
            },
          ),
        );
      });

      return Effect.flatMap(findResultId(operation, key), (recordedId) =>
        recordedId === undefined ? createOnce : readExisting(recordedId),
      ) as Effect.Effect<A, Exclude<E, DedupKeyTaken> | E2 | SqlError, R | R2>;
    },
  };
});

export const dedupKeyRepository = make;
