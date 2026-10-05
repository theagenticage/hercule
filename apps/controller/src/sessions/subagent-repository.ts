/**
 * The repository for a session's subagent records. A subagent belongs to its
 * session the way an input does, so this lives beside the session repository
 * rather than in a domain of its own.
 *
 * Nothing here decides what a record holds: `computeSubagentAfter` in
 * `subagents.ts` does, and the service writes back what it returns.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SubagentId } from "@hercule/protocol";
import type { SortDirection, SubagentStatus } from "@hercule/contract";
import {
  buildKeyset,
  buildPage,
  decodeOwnedCursor,
  encodeOwnedCursor,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";
import { parseUsage } from "./repository";
import type { StoredSubagent } from "./subagents";

/** What `subagentRepository.list` reads: one page of one session's subagents, in `direction` by `startedAt`. */
export interface SubagentPageRequest {
  readonly sessionId: string;
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
}

interface SubagentRow {
  readonly session_id: Uint8Array;
  readonly subagent_id: string;
  readonly parent_subagent_id: string | null;
  readonly item_id: string | null;
  readonly description: string | null;
  readonly agent_type: string | null;
  readonly model: string | null;
  readonly status: string;
  readonly tool_calls: number;
  readonly activity: string | null;
  readonly result: string | null;
  readonly usage: string | null;
  readonly usage_process: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
}

const COLUMNS =
  "session_id, subagent_id, parent_subagent_id, item_id, description, agent_type, model, " +
  "status, tool_calls, activity, result, usage, usage_process, started_at, ended_at";

/** Converts one `session_subagents` row into the record the rest of the domain works with. */
const toStoredSubagent = (row: SubagentRow): StoredSubagent => ({
  sessionId: uuidToString(row.session_id),
  id: row.subagent_id,
  parentSubagentId: row.parent_subagent_id ?? undefined,
  itemId: row.item_id ?? undefined,
  description: row.description ?? undefined,
  agentType: row.agent_type ?? undefined,
  model: row.model ?? undefined,
  status: row.status as SubagentStatus,
  toolCalls: row.tool_calls,
  activity: row.activity ?? undefined,
  result: row.result ?? undefined,
  usage: parseUsage(row.usage),
  usageProcess: parseUsage(row.usage_process),
  startedAt: row.started_at,
  endedAt: row.ended_at ?? undefined,
});

/**
 * Builds the cursor scope for one session's subagent list.
 *
 * The session id goes into the scope's sort field because the list is per
 * session, and the cursor holds only a position within one list. Without the
 * id, a cursor from one session's list would be accepted on another session's
 * list and silently skip rows there; with it, that cursor is refused.
 */
const buildCursorScope = (sessionId: string, direction: SortDirection): CursorScope => ({
  op: "session.querySubagents",
  sort: [{ field: `startedAt:${sessionId}`, direction }],
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Returns one subagent of a session, or `none` when the session has no such subagent. */
    one: (
      sessionId: string,
      subagentId: SubagentId,
    ): Effect.Effect<Option.Option<StoredSubagent>, SqlError> =>
      Effect.map(
        sql<SubagentRow>`
          SELECT ${sql.literal(COLUMNS)} FROM session_subagents
          WHERE session_id = ${uuidFromString(sessionId)} AND subagent_id = ${subagentId}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toStoredSubagent),
      ),

    /**
     * Returns the subagents of a session with the given ids, in no set order.
     * An id the session has no record of is left out of the result.
     */
    listByIds: (
      sessionId: string,
      ids: ReadonlyArray<SubagentId>,
    ): Effect.Effect<ReadonlyArray<StoredSubagent>, SqlError> =>
      ids.length === 0
        ? Effect.succeed([])
        : Effect.map(
            sql<SubagentRow>`
              SELECT ${sql.literal(COLUMNS)} FROM session_subagents
              WHERE session_id = ${uuidFromString(sessionId)} AND subagent_id IN ${sql.in(ids)}
            `,
            (rows) => rows.map(toStoredSubagent),
          ),

    /** Returns the subagents of a session whose status is `running`. */
    listRunning: (sessionId: string): Effect.Effect<ReadonlyArray<StoredSubagent>, SqlError> =>
      Effect.map(
        sql<SubagentRow>`
          SELECT ${sql.literal(COLUMNS)} FROM session_subagents
          WHERE session_id = ${uuidFromString(sessionId)} AND status = 'running'
        `,
        (rows) => rows.map(toStoredSubagent),
      ),

    /**
     * Returns every subagent of a session, oldest first. Used where every
     * record matters at once: a process starting, a stop that cascades down
     * the tree, and a resume.
     */
    listAll: (sessionId: string): Effect.Effect<ReadonlyArray<StoredSubagent>, SqlError> =>
      Effect.map(
        sql<SubagentRow>`
          SELECT ${sql.literal(COLUMNS)} FROM session_subagents
          WHERE session_id = ${uuidFromString(sessionId)}
          ORDER BY started_at, subagent_id
        `,
        (rows) => rows.map(toStoredSubagent),
      ),

    /** Returns one page of a session's subagents, sorted by `startedAt`, ties broken by id. */
    list: (
      request: SubagentPageRequest,
    ): Effect.Effect<Page<StoredSubagent>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildCursorScope(request.sessionId, request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeOwnedCursor(request.cursor, scope);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "started_at", direction: request.direction }],
          ["subagent_id"],
          after === undefined ? undefined : [after[0], after[2]],
        );
        const rows = yield* sql<SubagentRow>`
          SELECT ${sql.literal(COLUMNS)} FROM session_subagents
          WHERE session_id = ${uuidFromString(request.sessionId)} AND ${keyset}
          ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (found) => Effect.succeed(found.map(toStoredSubagent)),
          (last) => encodeOwnedCursor(scope, last.startedAt, last.sessionId, last.id),
        );
      }),

    /** Writes a subagent record whole, creating it or replacing the stored one. */
    save: (record: StoredSubagent): Effect.Effect<void, SqlError> => {
      const usage = record.usage === undefined ? null : JSON.stringify(record.usage);
      const usageProcess =
        record.usageProcess === undefined ? null : JSON.stringify(record.usageProcess);
      return Effect.asVoid(sql`
        INSERT INTO session_subagents (${sql.literal(COLUMNS)})
        VALUES (${uuidFromString(record.sessionId)}, ${record.id},
                ${record.parentSubagentId ?? null}, ${record.itemId ?? null},
                ${record.description ?? null}, ${record.agentType ?? null},
                ${record.model ?? null}, ${record.status}, ${record.toolCalls},
                ${record.activity ?? null}, ${record.result ?? null}, ${usage},
                ${usageProcess}, ${record.startedAt}, ${record.endedAt ?? null})
        ON CONFLICT (session_id, subagent_id) DO UPDATE SET
          parent_subagent_id = excluded.parent_subagent_id,
          item_id = excluded.item_id,
          description = excluded.description,
          agent_type = excluded.agent_type,
          model = excluded.model,
          status = excluded.status,
          tool_calls = excluded.tool_calls,
          activity = excluded.activity,
          result = excluded.result,
          usage = excluded.usage,
          usage_process = excluded.usage_process,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at
      `);
    },
  };
});

/** Builds the subagent repository over the ambient SQL client. */
export const subagentRepository = make;
