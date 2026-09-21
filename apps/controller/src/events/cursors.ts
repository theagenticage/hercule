/**
 * Where a durable consumer of the log has read to.
 *
 * A consumer keeps its position in the database rather than in memory, so a
 * controller that is killed between two passes picks the log up where it left
 * it instead of reading it from the start or skipping what it never read. The
 * position is the id of the last entry the consumer has finished with.
 *
 * It lives in this domain because the position is a position in this log: a
 * consumer that spelled the walk itself would be a second reader of the events
 * table outside the domain that owns it.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/**
 * The position this consumer stands at, creating its cursor at the start of
 * the log the first time it asks. Ids count from one, so a consumer that has
 * never run reads everything the log holds.
 */
export const openConsumerCursor = (
  sql: SqlClient.SqlClient,
  consumer: string,
): Effect.Effect<number, SqlError> =>
  Effect.gen(function* () {
    yield* sql`
      INSERT INTO event_cursors (consumer, position) VALUES (${consumer}, 0)
      ON CONFLICT (consumer) DO NOTHING
    `;
    const rows = yield* sql<{
      readonly position: number;
    }>`SELECT position FROM event_cursors WHERE consumer = ${consumer}`;
    return rows[0]!.position;
  });

/** Records that this consumer has finished with everything up to this position. */
export const advanceConsumerCursor = (
  sql: SqlClient.SqlClient,
  consumer: string,
  position: number,
): Effect.Effect<void, SqlError> =>
  Effect.asVoid(sql`UPDATE event_cursors SET position = ${position} WHERE consumer = ${consumer}`);
