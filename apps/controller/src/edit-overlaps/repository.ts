/**
 * Reads and writes the files each session edited (spec 19 section 2.4).
 * Nothing here decides policy: which Discussion is the target, and what gets
 * written when sessions overlap, are the service's.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { uuidFromString, uuidToString } from "../db";
import type { OverlapFile } from "../discussions";
import { UNFINISHED_SESSION_CONDITION } from "../sessions";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Records that the session edited the file, unless it did before, in which
     * case the first time stays. Returns whether it wrote a row, so false for
     * a file the session had edited already.
     */
    insertEditIfAbsent: (
      sessionId: string,
      resourceId: string,
      path: string,
      at: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly written: number }>`
          INSERT OR IGNORE INTO session_edits (session_id, resource_id, path, edited_at)
          VALUES (${uuidFromString(sessionId)}, ${uuidFromString(resourceId)}, ${path}, ${at})
          RETURNING 1 AS written
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Returns the files of repositories that the session edited, the first
     * edited first. A file of a Resource that is gone or is not a repository
     * is left out.
     */
    listEditedFiles: (sessionId: string): Effect.Effect<ReadonlyArray<OverlapFile>, SqlError> =>
      Effect.map(
        sql<{
          readonly resource_id: Uint8Array;
          readonly canonical_remote: string;
          readonly path: string;
        }>`
          SELECT e.resource_id, r.canonical_remote, e.path FROM session_edits e
          JOIN resources r ON r.id = e.resource_id AND r.kind = 'repo'
          WHERE e.session_id = ${uuidFromString(sessionId)}
          ORDER BY e.edited_at, e.rowid
        `,
        (rows) =>
          rows.map((row) => ({
            resourceId: uuidToString(row.resource_id),
            repository: row.canonical_remote,
            path: row.path,
          })),
      ),

    /**
     * Returns the ids of the unfinished sessions that edited the file, the
     * first to edit it first. Ties break by the order the rows were written.
     */
    listUnfinishedEditors: (
      resourceId: string,
      path: string,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly session_id: Uint8Array }>`
          SELECT e.session_id FROM session_edits e
          JOIN sessions s ON s.id = e.session_id
          WHERE e.resource_id = ${uuidFromString(resourceId)} AND e.path = ${path}
            AND ${sql.literal(UNFINISHED_SESSION_CONDITION)}
          ORDER BY e.edited_at, e.rowid
        `,
        (rows) => rows.map((row) => uuidToString(row.session_id)),
      ),
  };
});

/** The repository for the files sessions edited, used by the Edit Overlap service. */
export const editOverlapRepository = make;
