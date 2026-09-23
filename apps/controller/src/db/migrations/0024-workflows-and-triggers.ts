/**
 * Workflows, and a row for each trigger their sources declare.
 *
 * `source` is the text the author wrote, and only a write of a new text changes
 * it. `definition` is what that text parses to, as JSON. It is computed again
 * from `source` on every write and is never written on its own, so the two
 * cannot disagree. A listing reads a workflow's name and description out of
 * it. `enabled` is state of the row and not part of the text.
 *
 * A trigger row repeats what its workflow's source says about the trigger, so
 * that the triggers of every workflow can be listed and filtered together. It
 * is keyed by its workflow and by the id the source gives it, because that id
 * is unique only inside its workflow. `workflow_id` is a real foreign key: a
 * trigger means nothing without its workflow, and the cascade removes the
 * trigger rows in the statement that removes the workflow.
 *
 * `status` is state of the row too, and only a start trigger has one. A save
 * keeps the status of each trigger whose id is still in the source, so a paused
 * trigger stays paused while its workflow is edited. The check puts a status on
 * each start trigger and on no signal trigger.
 *
 * `connection_id` is text and not an id column, because it holds either the id
 * of a Connection or the word `any`.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE workflows (
      id BLOB PRIMARY KEY NOT NULL,
      source TEXT NOT NULL,
      definition TEXT NOT NULL CHECK (json_valid(definition)),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // The one listing: the workflow changed last first.
  yield* sql`CREATE INDEX workflows_updated ON workflows (updated_at, id)`;

  yield* sql`
    CREATE TABLE triggers (
      workflow_id BLOB NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
      trigger_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('start', 'signal')),
      event_kind TEXT NOT NULL,
      connection_id TEXT,
      filter TEXT,
      schedule TEXT,
      timezone TEXT,
      status TEXT CHECK (status IN ('active', 'paused')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workflow_id, trigger_id),
      CHECK ((kind = 'start') = (status IS NOT NULL))
    )
  `;
  // The listing across every workflow: the newest trigger first. The primary
  // key serves the listing of one workflow's triggers, and the cascade.
  yield* sql`CREATE INDEX triggers_created ON triggers (created_at, workflow_id, trigger_id)`;
});
