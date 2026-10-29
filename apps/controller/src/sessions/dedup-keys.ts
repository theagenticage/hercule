/**
 * The dedup keys of `session.spawn`, `session.continue` and `session.input`:
 * a retried call returns the first call's result instead of doing the work
 * again.
 *
 * A call looks its key up, writes its result and records its key in one
 * transaction. The controller has one writer, so that transaction runs alone:
 * a repeat finds the key and writes nothing, and two overlapping calls with
 * the same key cannot both create a result.
 *
 * The keys have a table of their own because `session_inputs.actor` is
 * rewritten when an input is edited, and `session.spawn` and `session.continue`
 * both write `sessions`.
 */
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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Returns the id that the current actor's earlier call to `operation` with
     * this `dedupKey` returned, or `undefined` when there is no such call.
     * Fails with `SqlError` when the query fails. Run it in the transaction
     * that writes the new result.
     */
    findResultId: (
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
      }),

    /**
     * Records that the current actor's call to `operation` with this
     * `dedupKey` returned `resultId`. Fails with `SqlError` when the key is
     * already recorded. After `findResultId` found nothing in the same
     * transaction that cannot happen, so such a failure is a bug. Run it in the
     * same transaction as `findResultId` and the write of the result.
     */
    recordDedupKey: (
      operation: DedupOperation,
      dedupKey: string,
      resultId: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const actor = yield* currentStamp;
        yield* sql`
          INSERT INTO session_dedup_keys (actor, operation, dedup_key, result_id)
          VALUES (${actor}, ${operation}, ${dedupKey}, ${uuidFromString(resultId)})
        `;
      }),
  };
});

export const dedupKeyRepository = make;
