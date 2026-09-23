/**
 * Reads a session's transcript as a log rather than as pages: the position of
 * its newest row, and the rows after a given position. The
 * `session:<id>:stream` live topic uses these to replay and follow the
 * transcript, the same way `apps/controller/src/events/log.ts` reads the event
 * log for the `event` topic.
 *
 * `transcript.read` reads the same table through
 * `sessionRepository.transcript`. That operation uses an opaque keyset cursor,
 * while the live topic's cursor is the raw position.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ProviderEvent } from "@hercule/protocol";
import type { TranscriptRow } from "@hercule/contract";
import { UUID_PATTERN, uuidFromString } from "../db";

/**
 * Checks whether a session with this id has ever been written. Returns `false`
 * for a string that is not a canonical id, so a caller does not have to
 * validate the id first: a topic for a session that never existed is treated
 * the same as one for a session that no longer exists.
 */
export const sessionExists = (
  sql: SqlClient.SqlClient,
  sessionId: string,
): Effect.Effect<boolean, SqlError> =>
  !UUID_PATTERN.test(sessionId)
    ? Effect.succeed(false)
    : Effect.map(
        sql<{ readonly found: number }>`
          SELECT 1 AS found FROM sessions WHERE id = ${uuidFromString(sessionId)}
        `,
        (rows) => rows.length > 0,
      );

/** Returns the position of a session's newest transcript row, or zero if it has none. */
export const readTranscriptHead = (
  sql: SqlClient.SqlClient,
  sessionId: string,
): Effect.Effect<number, SqlError> =>
  Effect.map(
    sql<{ readonly head: number | null }>`
      SELECT MAX(position) AS head FROM session_stream WHERE session_id = ${uuidFromString(sessionId)}
    `,
    (rows) => rows[0]?.head ?? 0,
  );

/** Returns up to `limit` rows of a session's stream after a position, oldest first. */
export const readTranscriptRowsAfter = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  after: number,
  limit: number,
): Effect.Effect<ReadonlyArray<TranscriptRow>, SqlError> =>
  Effect.map(
    sql<{ readonly position: number; readonly at: string; readonly event: string }>`
      SELECT position, at, event FROM session_stream
      WHERE session_id = ${uuidFromString(sessionId)} AND position > ${after}
      ORDER BY position LIMIT ${limit}
    `,
    (rows) =>
      rows.map((row) => ({
        position: row.position,
        at: row.at,
        event: JSON.parse(row.event) as ProviderEvent,
      })),
  );
