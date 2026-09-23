/**
 * Creates the `workflows` table, and the `triggers` table with one row per
 * trigger declared in a workflow's YAML.
 *
 * `source` is the YAML the author wrote. Only saving new YAML changes it.
 * `definition` is the parsed YAML, stored as JSON. It is parsed again from
 * `source` on every write and never written on its own, so the two cannot
 * disagree. Listings read a workflow's name and description from
 * `definition`. `enabled` belongs to the row and is not part of the YAML.
 *
 * A trigger row copies the trigger's fields from the workflow's YAML, so the
 * triggers of every workflow can be listed and filtered together. The primary
 * key is the workflow id plus the trigger id from the YAML, because a trigger
 * id is unique only inside its workflow. `workflow_id` is a real foreign key:
 * a trigger means nothing without its workflow, and the cascade deletes the
 * trigger rows in the same statement that deletes the workflow.
 *
 * `status` also belongs to the row, and only a start trigger has one. Saving a
 * workflow keeps the status of every trigger whose id is still in the YAML, so
 * a paused trigger stays paused while its workflow is edited. The CHECK
 * constraint requires a status on every start trigger and forbids one on a
 * signal trigger.
 *
 * `connection_id` is TEXT and not a BLOB id column, because it stores either a
 * Connection id or the word `any`.
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
  // Serves the workflow listing, which puts the most recently updated first.
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
  // Serves the listing of triggers across all workflows, newest first. The
  // primary key serves the listing of one workflow's triggers, and the cascade
  // delete.
  yield* sql`CREATE INDEX triggers_created ON triggers (created_at, workflow_id, trigger_id)`;
});
