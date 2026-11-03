/**
 * Adds `events.runner_id`, the runner an audit entry is about, so that a
 * machine's activity is one index range read (spec 04, Events by runner):
 *
 * - the column is nullable and has no foreign key, because the event log
 *   outlives the runners, workspaces and sessions it describes;
 * - the index is partial, because most events have no runner. A query on
 *   `runner_id = ?` can use it, since an equality never matches NULL;
 * - the entries already in the log are filled in, for the 19 kinds below and
 *   no other. The runner is the first of these that exists: the payload's
 *   `runnerId`, the runner of the workspace in the payload's `workspaceId`,
 *   the runner of the session in the payload's `sessionId`. An entry with none
 *   of them keeps `NULL`.
 *
 * The payload carries ids as hyphenated strings and the tables store 16 bytes,
 * so `unhex(replace(id, '-', ''))` converts one into the other. A string that
 * is not an id converts to `NULL` and falls through to the next source.
 *
 * The kinds are written out here and not imported, because a migration never
 * changes after it has run. The fill rewrites existing rows, so the upgrade
 * test (`e2e/upgrade.test.ts`) seeds audit entries of each kind with the
 * previous build.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE events ADD COLUMN runner_id BLOB`;
  yield* sql`CREATE INDEX events_runner_id ON events (runner_id, id) WHERE runner_id IS NOT NULL`;
  yield* sql`
    UPDATE events
    SET runner_id = coalesce(
      unhex(replace(json_extract(events.payload, '$.runnerId'), '-', '')),
      (SELECT workspaces.runner_id FROM workspaces
        WHERE workspaces.id = unhex(replace(json_extract(events.payload, '$.workspaceId'), '-', ''))),
      (SELECT sessions.runner_id FROM sessions
        WHERE sessions.id = unhex(replace(json_extract(events.payload, '$.sessionId'), '-', '')))
    )
    WHERE events.kind IN (
      'runner.joined', 'runner.stateChanged', 'runner.updated', 'runner.drained',
      'runner.undrained', 'runner.placementsChanged', 'runner.crashLooping', 'runner.retired',
      'workspace.created', 'workspace.disposalRequested', 'workspace.disposalRefused',
      'workspace.deleted', 'workspace.detached', 'workspace.attachmentRetried',
      'session.spawned', 'session.stopped', 'session.reconciled', 'session.archived',
      'providerAccount.signedIn'
    )
  `;
});
