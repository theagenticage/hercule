/**
 * A session's transcript, read as a log rather than as a page: the position of
 * its newest row, and the rows after a position. What `session:<id>:stream`
 * replays from and follows, the way `apps/controller/src/events/log.ts` reads
 * the event log for `event`. `transcript.read` walks the same table through
 * `sessionRepository.transcript`, whose opaque keyset cursor is a different
 * concern from the raw position this topic's cursor is.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ProviderEvent } from "@hydra/protocol";
import type { TranscriptRow } from "@hydra/contract";
import { UUID_PATTERN, uuidFromString } from "../db";

/**
 * Whether a session with this id has ever been written. `false` for anything
 * that is not even a canonical id, so a caller need not validate the shape
 * before asking: a topic naming a session that was never real reads exactly
 * like one that no longer is.
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

/** The position of a session's newest transcript row, or zero for one with none. */
export const headOfTranscript = (
  sql: SqlClient.SqlClient,
  sessionId: string,
): Effect.Effect<number, SqlError> =>
  Effect.map(
    sql<{ readonly head: number | null }>`
      SELECT MAX(position) AS head FROM session_stream WHERE session_id = ${uuidFromString(sessionId)}
    `,
    (rows) => rows[0]?.head ?? 0,
  );

/** The next rows of a session's stream after a position, oldest first. */
export const transcriptRowsAfter = (
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
