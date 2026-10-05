/**
 * Reads one agent's transcript as a log rather than as pages. Each agent of a
 * session has its own transcript: the session's own agent's, picked by a
 * `subagentId` of `undefined`, and one per subagent. The positions are shared
 * by every agent of the session, so one agent's rows have gaps between them.
 *
 * - the position of its newest row, and the rows after a given position. The
 *   `session:<id>:stream` and `session:<id>:subagent:<subagentId>:stream`
 *   live topics use these to replay and follow the transcript, the same way
 *   `apps/controller/src/events/log.ts` reads the event log for the `event`
 *   topic;
 * - the assistant text of one turn or one item, which the assistants domain
 *   turns into conversation replies. It reads only the rows since the turn's
 *   or the item's start, walking back from the newest row, so its cost does
 *   not grow with the length of the session.
 *
 * `transcript.read` reads the same table through
 * `sessionRepository.transcript`. That operation uses an opaque keyset cursor,
 * while the live topic's cursor is the raw position.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ProviderEvent, SubagentId } from "@hercule/protocol";
import type { TranscriptRow } from "@hercule/contract";
import { UUID_PATTERN, uuidFromString } from "../db";
import { buildAgentClause } from "./repository";

/**
 * Checks whether an agent's transcript can exist: the session has ever been
 * written and, when `subagentId` is given, the session has a record of that
 * subagent. Returns `false` for a session id that is not a canonical id, so a
 * caller does not have to validate the id first: a topic for a session that
 * never existed is treated the same as one for a session that no longer
 * exists.
 */
export const agentExists = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  subagentId: SubagentId | undefined,
): Effect.Effect<boolean, SqlError> =>
  !UUID_PATTERN.test(sessionId)
    ? Effect.succeed(false)
    : Effect.map(
        subagentId === undefined
          ? sql<{ readonly found: number }>`
              SELECT 1 AS found FROM sessions WHERE id = ${uuidFromString(sessionId)}
            `
          : sql<{ readonly found: number }>`
              SELECT 1 AS found FROM session_subagents
              WHERE session_id = ${uuidFromString(sessionId)} AND subagent_id = ${subagentId}
            `,
        (rows) => rows.length > 0,
      );

/** Returns the position of an agent's newest transcript row, or zero if it has none. */
export const readTranscriptHead = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  subagentId: SubagentId | undefined,
): Effect.Effect<number, SqlError> =>
  Effect.map(
    sql<{ readonly head: number | null }>`
      SELECT MAX(position) AS head FROM session_stream
      WHERE session_id = ${uuidFromString(sessionId)} AND ${buildAgentClause(sql, subagentId)}
    `,
    (rows) => rows[0]?.head ?? 0,
  );

/** Returns up to `limit` rows of an agent's transcript after a position, oldest first. */
export const readTranscriptRowsAfter = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  subagentId: SubagentId | undefined,
  after: number,
  limit: number,
): Effect.Effect<ReadonlyArray<TranscriptRow>, SqlError> =>
  Effect.map(
    sql<{ readonly position: number; readonly at: string; readonly event: string }>`
      SELECT position, at, event FROM session_stream
      WHERE session_id = ${uuidFromString(sessionId)} AND ${buildAgentClause(sql, subagentId)}
        AND position > ${after}
      ORDER BY position LIMIT ${limit}
    `,
    (rows) =>
      rows.map((row) => ({
        position: row.position,
        at: row.at,
        event: JSON.parse(row.event) as ProviderEvent,
      })),
  );

/** The assistant text of one item of a turn. */
interface AssistantText {
  readonly itemId: string;
  readonly text: string;
}

/**
 * Returns the assistant text one agent streamed so far, one entry per item, in
 * the order the items began. `subagentId` picks the agent: `undefined` reads
 * the session's own agent, which is what an assistant's reply is made of, and
 * never a subagent's text. Each entry joins the item's stored delta rows,
 * because an item longer than the delta flush size is stored as several rows.
 * An item with no assistant text, such as a command, has no entry.
 *
 * - Without `itemId`, it reads the turn's text, from the turn's `turn.started`
 *   row on.
 * - With `itemId`, it reads only that item's text, from the item's
 *   `item.started` row on.
 *
 * The start row is found by walking the agent's rows back from the newest.
 * The walk stops at the first row that is the start row, any `turn.started`,
 * or another turn's `turn.completed`. So neither the walk nor the read ever
 * covers more than the current turn, and a caller that reads each item as it
 * completes reads each item once. When the walk stops anywhere other than the
 * start row, the start row is missing, and it returns no entries.
 *
 * Only rows already written are read, so a caller that reads inside the
 * transaction applying a turn's end also sees the rows that end flushed.
 */
export const readAssistantTexts = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  subagentId: SubagentId | undefined,
  turnId: string,
  itemId?: string,
): Effect.Effect<ReadonlyArray<AssistantText>, SqlError> =>
  Effect.gen(function* () {
    const session = uuidFromString(sessionId);
    const agent = buildAgentClause(sql, subagentId);
    const found = yield* sql<{
      readonly position: number;
      readonly tag: string;
      readonly turnId: string | null;
      readonly itemId: string | null;
    }>`
      SELECT position, json_extract(event, '$._tag') AS tag,
             json_extract(event, '$.turnId') AS turnId, json_extract(event, '$.itemId') AS itemId
      FROM session_stream
      WHERE session_id = ${session} AND ${agent}
        AND (json_extract(event, '$._tag') = 'turn.started'
             OR (json_extract(event, '$._tag') = 'turn.completed'
                 AND json_extract(event, '$.turnId') <> ${turnId})
             ${
               itemId === undefined
                 ? sql``
                 : sql`OR (json_extract(event, '$._tag') = 'item.started'
                           AND json_extract(event, '$.itemId') = ${itemId})`
             })
      ORDER BY position DESC LIMIT 1
    `;
    const start = found[0];
    const isStartRow =
      start !== undefined &&
      start.turnId === turnId &&
      (itemId === undefined
        ? start.tag === "turn.started"
        : start.tag === "item.started" && start.itemId === itemId);
    if (!isStartRow) return [];
    const rows = yield* sql<{ readonly itemId: string; readonly delta: string }>`
      SELECT json_extract(event, '$.itemId') AS itemId, json_extract(event, '$.delta') AS delta
      FROM session_stream
      WHERE session_id = ${session} AND ${agent}
        AND position > ${start.position}
        AND json_extract(event, '$._tag') = 'content.delta'
        AND json_extract(event, '$.streamKind') = 'assistant_text'
        AND json_extract(event, '$.turnId') = ${turnId}
        ${itemId === undefined ? sql`` : sql`AND json_extract(event, '$.itemId') = ${itemId}`}
      ORDER BY position
    `;
    const byItem = new Map<string, string>();
    for (const row of rows) byItem.set(row.itemId, (byItem.get(row.itemId) ?? "") + row.delta);
    return [...byItem].map(([id, text]) => ({ itemId: id, text }));
  });
