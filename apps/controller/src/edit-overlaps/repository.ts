/**
 * Reads and writes the files each session edited (spec 19 section 2.4).
 * Nothing here decides policy: which Discussion is the target, and what gets
 * written when sessions overlap, are the service's.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { uuidFromString, uuidToString } from "../db";

/** A file a session edited, and when it first did. */
export interface SessionEdit {
  readonly resourceId: string;
  readonly path: string;
  readonly editedAt: string;
}

/** A session that edited a file, and when it first did. */
export interface FileEditor {
  readonly sessionId: string;
  readonly editedAt: string;
}

/**
 * The SQL condition that holds for an unfinished session (spec 19 section
 * 4.2), for the row of `sessions` aliased `s`:
 *
 * - a Thread (no Agent behind it) is unfinished until it is Done;
 * - an agent step's session (it has a run) is unfinished while its Run is
 *   `pending` or `running`;
 * - any other session is unfinished until it exits.
 */
const UNFINISHED_SESSION = `(CASE
  WHEN s.agent_id IS NULL THEN s.done_at IS NULL
  WHEN s.run_id IS NOT NULL THEN EXISTS (
    SELECT 1 FROM runs r WHERE r.id = s.run_id AND r.status IN ('pending', 'running'))
  ELSE s.status <> 'exited'
END)`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Records that the session edited the file, unless it did before. Keeps the first time. */
    insertEditIfAbsent: (
      sessionId: string,
      resourceId: string,
      path: string,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT OR IGNORE INTO session_edits (session_id, resource_id, path, edited_at)
        VALUES (${uuidFromString(sessionId)}, ${uuidFromString(resourceId)}, ${path}, ${at})
      `),

    /** Returns the files the session edited, the first edited first. */
    listEditsOf: (sessionId: string): Effect.Effect<ReadonlyArray<SessionEdit>, SqlError> =>
      Effect.map(
        sql<{
          readonly resource_id: Uint8Array;
          readonly path: string;
          readonly edited_at: string;
        }>`
          SELECT resource_id, path, edited_at FROM session_edits
          WHERE session_id = ${uuidFromString(sessionId)} ORDER BY edited_at, rowid
        `,
        (rows) =>
          rows.map((row) => ({
            resourceId: uuidToString(row.resource_id),
            path: row.path,
            editedAt: row.edited_at,
          })),
      ),

    /** Checks whether the session is unfinished. A session that does not exist is not. */
    isUnfinished: (sessionId: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly found: number }>`
          SELECT 1 AS found FROM sessions s
          WHERE s.id = ${uuidFromString(sessionId)} AND ${sql.literal(UNFINISHED_SESSION)}
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Returns the unfinished sessions that edited the file, the most recent
     * edit first. Ties break by the order the rows were written, newest first.
     */
    listUnfinishedEditors: (
      resourceId: string,
      path: string,
    ): Effect.Effect<ReadonlyArray<FileEditor>, SqlError> =>
      Effect.map(
        sql<{ readonly session_id: Uint8Array; readonly edited_at: string }>`
          SELECT e.session_id, e.edited_at FROM session_edits e
          JOIN sessions s ON s.id = e.session_id
          WHERE e.resource_id = ${uuidFromString(resourceId)} AND e.path = ${path}
            AND ${sql.literal(UNFINISHED_SESSION)}
          ORDER BY e.edited_at DESC, e.rowid DESC
        `,
        (rows) =>
          rows.map((row) => ({
            sessionId: uuidToString(row.session_id),
            editedAt: row.edited_at,
          })),
      ),
  };
});

/** The repository for the files sessions edited, used by the Edit Overlap service. */
export const editOverlapRepository = make;
