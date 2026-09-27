/**
 * Adds workspace leases, and moves the decision of how long a workspace is
 * kept from the workspace sweep to the holders of the workspace.
 *
 * A lease records that a session or a run uses a workspace. It is active
 * while the holder uses the workspace. When the holder is done, it releases
 * the lease and picks a retention, and the release stamps `kept_until`, the
 * time until which the lease keeps the workspace. The sweep deletes an
 * ephemeral workspace once no lease on it is active and every `kept_until`
 * has passed. It no longer reads the runs or sessions tables.
 *
 * The migration backfills a lease for every session and run that has a
 * workspace, with the result the sweep reached for it before:
 *
 * - a session that has not exited holds an active lease;
 * - an exited session released its lease when it exited: `idle` (30 days)
 *   if it can still be resumed, otherwise `orphan` (24 hours);
 * - a pending or running run holds an active lease;
 * - a finished run released its lease when it finished: `inspection`
 *   (14 days) if it failed, or was cancelled with its workspace kept,
 *   otherwise `none`.
 *
 * A released lease is then deleted again when its workspace is a primary or
 * is gone, because only an ephemeral workspace that still exists is kept by
 * its released leases.
 *
 * The windows are the default values of the settings, written out here. A
 * migration must give the same result on every database, so it does not read
 * the settings a user may have changed.
 *
 * `runs.keep_workspace` is dropped: the choice it recorded is now the
 * retention of the run's lease. The `runs_workspace` index is dropped too,
 * because the sweep and `workspace.dispose` were the only queries that found
 * a run by its workspace.
 *
 * The controller setting `workspace.failedRunTtlDays` is renamed
 * `workspace.inspectionTtlDays`, because it now sets the window of every
 * `inspection` release, not only a failed run's. A value the user stored
 * under the old key moves to the new one, so it keeps applying.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const ORPHAN = "+24 hours";
const IDLE = "+30 days";
const INSPECTION = "+14 days";

/**
 * Formats a SQL expression that adds a window to a timestamp and keeps the
 * ISO 8601 form every other timestamp in the database has.
 */
const addWindow = (column: string, window: string): string =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', ${column}, '${window}')`;

/**
 * The condition for a session that can be resumed, as the sessions domain
 * computed it when this migration was written. It is copied rather than
 * imported, because a migration must not change when that code changes.
 */
const RESUMABLE =
  "s.native_session_id IS NOT NULL " +
  "AND EXISTS (SELECT 1 FROM runners WHERE runners.id = s.runner_id " +
  "AND runners.lifecycle <> 'retired') " +
  "AND EXISTS (SELECT 1 FROM workspaces WHERE workspaces.id = s.workspace_id " +
  "AND workspaces.status = 'ready') " +
  "AND (s.conversation_id IS NULL OR EXISTS (SELECT 1 FROM conversations " +
  "WHERE conversations.id = s.conversation_id))";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `holder_id` is not a foreign key, as in `subscriptions`: the holder is a
  // session or a run, two different tables.
  yield* sql`
    CREATE TABLE workspace_leases (
      workspace_id BLOB NOT NULL REFERENCES workspaces(id),
      holder_kind TEXT NOT NULL CHECK (holder_kind IN ('session', 'run')),
      holder_id BLOB NOT NULL,
      acquired_at TEXT NOT NULL,
      released_at TEXT,
      retention TEXT CHECK (retention IN ('none', 'orphan', 'idle', 'inspection')),
      kept_until TEXT,
      CHECK ((released_at IS NULL) = (retention IS NULL)
         AND (released_at IS NULL) = (kept_until IS NULL)),
      PRIMARY KEY (workspace_id, holder_kind, holder_id)
    )
  `;

  // Finds the leases of one holder, which a release updates. The index is not
  // partial: releasing a session's lease again after its conversation is
  // deleted updates a lease that is already released, so the lookup covers
  // both states.
  yield* sql`
    CREATE INDEX workspace_leases_holder ON workspace_leases (holder_kind, holder_id)
  `;

  // A session's `exited_at` is written in the same update that ends it; the
  // COALESCE only keeps a row the old code left without one from breaking the
  // CHECK above.
  const exitedAt = "COALESCE(s.exited_at, s.last_activity_at)";
  yield* sql.unsafe(`
    INSERT INTO workspace_leases (workspace_id, holder_kind, holder_id, acquired_at,
                                  released_at, retention, kept_until)
    SELECT s.workspace_id, 'session', s.id, s.created_at,
           CASE WHEN s.status = 'exited' THEN ${exitedAt} END,
           CASE WHEN s.status <> 'exited' THEN NULL
                WHEN ${RESUMABLE} THEN 'idle' ELSE 'orphan' END,
           CASE WHEN s.status <> 'exited' THEN NULL
                WHEN ${RESUMABLE} THEN ${addWindow(exitedAt, IDLE)}
                ELSE ${addWindow(exitedAt, ORPHAN)} END
    FROM sessions s
    WHERE s.workspace_id IS NOT NULL
  `);

  const kept = "r.status = 'failed' OR (r.status = 'cancelled' AND r.keep_workspace = 1)";
  yield* sql.unsafe(`
    INSERT INTO workspace_leases (workspace_id, holder_kind, holder_id, acquired_at,
                                  released_at, retention, kept_until)
    SELECT r.workspace_id, 'run', r.id, COALESCE(r.started_at, r.created_at),
           r.finished_at,
           CASE WHEN r.status IN ('pending', 'running') THEN NULL
                WHEN ${kept} THEN 'inspection' ELSE 'none' END,
           CASE WHEN r.status IN ('pending', 'running') THEN NULL
                WHEN ${kept} THEN ${addWindow("r.finished_at", INSPECTION)}
                ELSE r.finished_at END
    FROM runs r
    WHERE r.workspace_id IS NOT NULL
  `);

  // A released lease is kept only where the sweep reads it: on an ephemeral
  // workspace that is not gone. On a primary, which the sweep never deletes,
  // or on a workspace that is already gone, it means nothing, and the
  // workspaces domain deletes it at release.
  yield* sql`
    DELETE FROM workspace_leases
    WHERE released_at IS NOT NULL
      AND workspace_id IN (SELECT id FROM workspaces
                           WHERE kind = 'primary' OR status IN ('deleted', 'lost'))
  `;

  yield* sql`DROP INDEX runs_workspace`;
  yield* sql`ALTER TABLE runs DROP COLUMN keep_workspace`;

  yield* sql`
    UPDATE settings SET key = 'workspace.inspectionTtlDays'
    WHERE scope = 'controller' AND key = 'workspace.failedRunTtlDays'
  `;
});
