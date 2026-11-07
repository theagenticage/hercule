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
 *   turns into conversation replies, and a subagent's last message into its
 *   result. It reads only the rows since the turn's or the item's start,
 *   walking back from the newest row, so its cost does not grow with the
 *   length of the session;
 * - the turn a subagent has open, if any.
 *
 * `transcript.read` reads the same table through
 * `sessionRepository.transcript`. That operation uses an opaque keyset cursor,
 * while the live topic's cursor is the raw position.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { parseStoredEvent, type HarnessEvent, type SubagentId } from "@hercule/protocol";
import type { TranscriptRow } from "@hercule/contract";
import { UUID_PATTERN, uuidFromString } from "../db";
import { takeTail } from "../text";
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

/**
 * Returns `event` without its `raw`, the vendor's untouched payload, which
 * makes up most of a transcript's bytes and which no client draws. Only the
 * event's own `raw` goes: an `unknown` event keeps its `payload` whole, `raw`
 * included, because that payload is the event this build could not read.
 * The stored event keeps its `raw`; only what a read sends leaves it out.
 */
export const omitRawPayload = (event: HarnessEvent): HarnessEvent => {
  if (!("raw" in event)) return event;
  const copy = { ...event };
  delete copy.raw;
  return copy;
};

/**
 * Returns up to `limit` rows of an agent's transcript after a position, oldest
 * first, each without its `raw` (see `omitRawPayload`): the live topics never
 * send it. Each comes with `bytes`, the size in bytes of its stored JSON text.
 * A live subscription uses it to limit the memory it holds for a client that
 * reads slowly, without encoding the row again. The stored text still holds
 * `raw`, so `bytes` is more than the row costs: the limit errs on the safe
 * side. The size is `length(CAST(event AS BLOB))`, which counts bytes in every
 * SQLite version (`octet_length` needs SQLite 3.43, and the SQLite that Bun
 * links on macOS can be older). An event of a type this build does not know
 * comes back as an `unknown` event (see `parseStoredEvent`).
 */
export const readTranscriptRowsAfter = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  subagentId: SubagentId | undefined,
  after: number,
  limit: number,
): Effect.Effect<
  ReadonlyArray<{ readonly row: TranscriptRow; readonly bytes: number }>,
  SqlError
> =>
  Effect.map(
    sql<{
      readonly position: number;
      readonly at: string;
      readonly event: string;
      readonly bytes: number;
    }>`
      SELECT position, at, event, length(CAST(event AS BLOB)) AS bytes FROM session_stream
      WHERE session_id = ${uuidFromString(sessionId)} AND ${buildAgentClause(sql, subagentId)}
        AND position > ${after}
      ORDER BY position LIMIT ${limit}
    `,
    (rows) =>
      rows.map((row) => ({
        row: {
          position: row.position,
          at: row.at,
          event: omitRawPayload(parseStoredEvent(row.event)),
        },
        bytes: row.bytes,
      })),
  );

/** The assistant text of one item of a turn. */
interface AssistantText {
  readonly itemId: string;
  readonly text: string;
}

/** One turn, or one item of a turn, of one agent of a session. */
export interface AgentTurn {
  readonly sessionId: string;
  /** The subagent whose turn it is, or absent for the session's own agent. */
  readonly subagentId?: SubagentId | undefined;
  readonly turnId: string;
  /** The item within the turn, when only that item is meant. */
  readonly itemId?: string | undefined;
}

/**
 * Checks whether an agent started any turn other than `turnId`. Used to tell
 * a subagent's first turn, whose input is the brief its parent gave it, from
 * a later one. Reads the agent's rows already written, so inside the
 * transaction that applies an event it sees that event's rows too.
 */
export const hasOtherTurn = (
  sql: SqlClient.SqlClient,
  turn: Omit<AgentTurn, "itemId">,
): Effect.Effect<boolean, SqlError> =>
  Effect.map(
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM session_stream
      WHERE session_id = ${uuidFromString(turn.sessionId)}
        AND ${buildAgentClause(sql, turn.subagentId)}
        AND json_extract(event, '$._tag') = 'turn.started'
        AND json_extract(event, '$.turnId') <> ${turn.turnId}
      LIMIT 1
    `,
    (rows) => rows.length > 0,
  );

/**
 * Returns the id of a subagent's open turn: the turn of its newest
 * `turn.started` row, when no `turn.completed` row comes after it. Returns
 * `undefined` when the subagent has no turn, or its last turn ended.
 *
 * Used when the session ends while the subagent is still running, to find
 * the turn whose last message becomes its result. Only rows already written
 * are read, like `readAssistantTexts`.
 */
export const readOpenTurnId = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  subagentId: SubagentId,
): Effect.Effect<string | undefined, SqlError> =>
  Effect.map(
    sql<{ readonly tag: string; readonly turnId: string }>`
      SELECT json_extract(event, '$._tag') AS tag, json_extract(event, '$.turnId') AS turnId
      FROM session_stream
      WHERE session_id = ${uuidFromString(sessionId)} AND ${buildAgentClause(sql, subagentId)}
        AND json_extract(event, '$._tag') IN ('turn.started', 'turn.completed')
      ORDER BY position DESC LIMIT 1
    `,
    (rows) => (rows[0]?.tag === "turn.started" ? rows[0].turnId : undefined),
  );

/**
 * Returns the assistant text one agent streamed so far, one entry per item, in
 * the order the items began. `subagentId` picks the agent: absent reads
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
  { sessionId, subagentId, turnId, itemId }: AgentTurn,
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

/**
 * How many of an agent's newest stream rows `readRecentAssistantText` looks
 * at. Tool events sit between the text deltas, so this is far more than the
 * deltas it needs. A fixed window keeps the read from growing with the turn.
 */
const RECENT_TEXT_WINDOW = 200;

/**
 * Returns the newest assistant text of a session's own agent, at most
 * `maxChars` characters, in reading order. A subagent's text is never
 * included. Returns an empty string when the newest rows hold no assistant
 * text.
 *
 * The read looks at the newest `RECENT_TEXT_WINDOW` stream rows of the agent
 * and takes the newest `maxRows` text deltas among them. It keeps the newest
 * `maxChars` characters of those, so it cuts the oldest text and never the end
 * of the answer. An item longer than the delta flush size is stored as several
 * rows, which are joined directly. The text of different items is separated by
 * a blank line.
 *
 * Unlike `readAssistantTexts`, the work does not grow with the turn: it
 * walks the `session_stream_agent` index back from the newest row and stops
 * at the window, so a turn of thousands of deltas costs the same as a short
 * one. The text may therefore start in the middle of an answer.
 */
export const readRecentAssistantText = (
  sql: SqlClient.SqlClient,
  { sessionId, maxRows, maxChars }: { sessionId: string; maxRows: number; maxChars: number },
): Effect.Effect<string, SqlError> =>
  Effect.map(
    sql<{ readonly itemId: string; readonly delta: string }>`
      SELECT json_extract(event, '$.itemId') AS itemId, json_extract(event, '$.delta') AS delta
      FROM (
        SELECT position, event FROM session_stream
        WHERE session_id = ${uuidFromString(sessionId)} AND ${buildAgentClause(sql, undefined)}
        ORDER BY position DESC LIMIT ${RECENT_TEXT_WINDOW}
      )
      WHERE json_extract(event, '$._tag') = 'content.delta'
        AND json_extract(event, '$.streamKind') = 'assistant_text'
      ORDER BY position DESC LIMIT ${maxRows}
    `,
    (newestFirst) => {
      const inOrder = newestFirst.toReversed();
      const text = inOrder
        .map((row, index) => {
          const startsNewItem = index > 0 && inOrder[index - 1]!.itemId !== row.itemId;
          return (startsNewItem ? "\n\n" : "") + row.delta;
        })
        .join("");
      return takeTail(text, maxChars);
    },
  );
