/**
 * The lead of a Task: the one Thread that speaks for it (`tasks.lead_session_id`).
 *
 * This module owns the rules for who leads and the SQL that keeps the column
 * true. `TaskService` is the only caller. The rules:
 *
 * - Only a session of kind `thread` leads. Agent, run and assistant sessions
 *   never do. Any Thread counts, archived or Done included.
 * - A Thread that joins a Task with no lead becomes its lead.
 * - A Thread that makes a new Task for itself (the join rule) leads it from the
 *   Task's first write, so `task.created` carries the lead. This is the one
 *   rule applied outside this module, by `joinSession`; `settleLeadAfterMove`
 *   then finds the lead set and changes and announces nothing.
 * - A fork made by `session.continue` of the Task's current lead, that lands on
 *   the same Task, takes the lead over. A fork the join rule put on another
 *   Task takes nothing from the Task it came from.
 * - When a Thread leaves a Task it leads, the oldest Thread left on that Task
 *   leads, or nobody when none is left.
 * - A merge keeps the survivor's lead and takes the source's only when the
 *   survivor has none. It also moves the source's stage report to the survivor
 *   under the same condition.
 *
 * Callers pass no candidates: the functions read membership and kind from the
 * database, so they must run after the session's row was written, in the same
 * transaction as that write.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { uuidFromString, uuidToString } from "../db";
import { buildLiveTaskCondition } from "./repository";

/** What happened to a session's Task, as far as the lead rules care. */
export interface LeadMove {
  readonly sessionId: string;
  /** The Task the session was on before, or undefined when it is new or had none. */
  readonly fromTaskId: string | undefined;
  /** The Task the session is on now, or undefined when it has none. */
  readonly toTaskId: string | undefined;
  /** The session this one was forked from by `session.continue`, or undefined for any other session. */
  readonly continuedFromSessionId: string | undefined;
}

export const makeLeads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readLead = (taskId: string): Effect.Effect<string | null, SqlError> =>
    Effect.map(
      sql<{ readonly lead_session_id: Uint8Array | null }>`
        SELECT lead_session_id FROM tasks WHERE id = ${uuidFromString(taskId)}
      `,
      (rows) => (rows[0]?.lead_session_id == null ? null : uuidToString(rows[0].lead_session_id)),
    );

  const writeLead = (taskId: string, leadId: string | null): Effect.Effect<void, SqlError> =>
    Effect.asVoid(sql`
      UPDATE tasks
      SET lead_session_id = ${leadId === null ? null : uuidFromString(leadId)}
      WHERE id = ${uuidFromString(taskId)}
    `);

  /** Returns the oldest Thread on the Task, by `(created_at, id)`, or null when it has none. */
  const readOldestThread = (taskId: string): Effect.Effect<string | null, SqlError> =>
    Effect.map(
      sql<{ readonly id: Uint8Array }>`
        SELECT id FROM sessions
        WHERE task_id = ${uuidFromString(taskId)} AND kind = 'thread'
        ORDER BY created_at, id
        LIMIT 1
      `,
      (rows) => (rows[0] === undefined ? null : uuidToString(rows[0].id)),
    );

  return {
    /**
     * Returns the title of the Task the session leads, or none when the session
     * is on no Task, leads none, or the Task is deleted, merged into another Task, done or
     * dropped: nothing is left to report on those.
     */
    readLedTaskTitle: (sessionId: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly title: string }>`
          SELECT t.title
          FROM sessions s
          JOIN tasks t ON t.id = s.task_id
          WHERE s.id = ${uuidFromString(sessionId)}
            AND t.lead_session_id = s.id
            AND ${sql.literal(buildLiveTaskCondition("t"))}
            AND t.stage NOT IN ('done', 'dropped')
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => row.title),
      ),

    /**
     * Brings the lead of the Tasks a session left and joined in line with the
     * rules above, and returns the ids of the Tasks whose lead changed (none
     * when nothing did). Call it after the session's `task_id` was written,
     * inside that write's transaction. Fails only with `SqlError`.
     */
    settleLeadAfterMove: (move: LeadMove): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.gen(function* () {
        const changed: Array<string> = [];
        if (move.toTaskId !== undefined) {
          // One statement checks all three conditions: the session is a
          // Thread, and the Task has no lead or the lead this session
          // continues. It runs on every session create, so it reads nothing first.
          const joined = yield* sql`
            UPDATE tasks
            SET lead_session_id = ${uuidFromString(move.sessionId)}
            WHERE id = ${uuidFromString(move.toTaskId)}
              AND (
                lead_session_id IS NULL
                OR lead_session_id = ${
                  move.continuedFromSessionId === undefined
                    ? null
                    : uuidFromString(move.continuedFromSessionId)
                }
              )
              AND EXISTS (
                SELECT 1 FROM sessions
                WHERE id = ${uuidFromString(move.sessionId)} AND kind = 'thread'
              )
            RETURNING id
          `;
          if (joined.length > 0) changed.push(move.toTaskId);
        }
        if (move.fromTaskId !== undefined && move.fromTaskId !== move.toTaskId) {
          if ((yield* readLead(move.fromTaskId)) === move.sessionId) {
            yield* writeLead(move.fromTaskId, yield* readOldestThread(move.fromTaskId));
            changed.push(move.fromTaskId);
          }
        }
        return changed;
      }),

    /**
     * Settles the lead and the stage report of a merge, after the source's
     * sessions were moved to the survivor. The survivor keeps its own lead and
     * its own report row. When it has none, it takes the source's. Whatever
     * the source still holds is cleared or deleted. Fails only with `SqlError`.
     */
    settleLeadAfterMerge: (input: {
      readonly survivorTaskId: string;
      readonly sourceTaskId: string;
    }): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const survivor = uuidFromString(input.survivorTaskId);
        const source = uuidFromString(input.sourceTaskId);
        const sourceLead = yield* readLead(input.sourceTaskId);
        if ((yield* readLead(input.survivorTaskId)) === null && sourceLead !== null) {
          yield* writeLead(input.survivorTaskId, sourceLead);
        }
        yield* writeLead(input.sourceTaskId, null);
        // The table has one row per Task, so the move is guarded: it would
        // break the primary key when the survivor already has a row.
        yield* sql`
          UPDATE task_stage_reports SET task_id = ${survivor}
          WHERE task_id = ${source}
            AND NOT EXISTS (SELECT 1 FROM task_stage_reports WHERE task_id = ${survivor})
        `;
        yield* sql`DELETE FROM task_stage_reports WHERE task_id = ${source}`;
      }),
  };
});
