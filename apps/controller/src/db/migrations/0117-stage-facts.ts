/**
 * Lets a Task's stage follow facts about the things it links, and lets a
 * shipped workflow be installed once.
 *
 * - `task_entity_facts` has one row per fact about a linked External Entity,
 *   for one Task. Its `id` is the fact's order: there is one writer, so ids
 *   follow commit order, and nothing compares timestamps. `AUTOINCREMENT`
 *   keeps an id from ever being reused, so a fence that remembers an id is
 *   never fooled by a deleted row. `previous_lifecycle` is null when the
 *   entity was only just linked or observed. `observed_at` is for display.
 *   `voided_at` is set when the user unlinks the pair, which kills every fact
 *   queued for it. The index on `(task_id, ref, id)` serves a Task's facts for
 *   one ref in order.
 * - `task_entity_link_suppressions` has one row per pair the user unlinked,
 *   so that no scan adds the link back. A link made by hand removes the row.
 * - `shipped_workflows` has one row per workflow that ships with Hercule, by
 *   its stable key. A row means the key was installed once, and it stays when
 *   the user deletes the workflow, so a deleted one never comes back.
 *   `workflow_id` is not a foreign key for that reason.
 * - `tracked_branch_attempts` remembers when each tracked branch of a
 *   Connection was last asked about, so that a fair rotation survives a
 *   restart. Branches have no rows of their own: they are a JSON list on a
 *   checkout.
 * - `external_entities_head` serves the branch link step and the tracked
 *   branches: it finds the entities whose `repository.head` is a given
 *   `(remote, branch)` without reading every entity. It is an index on the two
 *   JSON expressions, and only entities that have a head are in it. A query
 *   uses it only when it writes the expressions exactly as written here.
 * - `external_entities.source_created_at` is when the source created the thing,
 *   as the plugin reports it. It never changes, unlike `source_updated_at`, so
 *   the branch link step uses it to tell a pull request made before a Task's
 *   workspace from one made after it. A row read before this column existed
 *   has none until its next observation.
 * - `tasks.stage_fact_fence` is the highest fact id the Task already accounts
 *   for. A stage write that comes from a fact at or below it does nothing.
 *   `tasks.stage_cause_fact_id` is the fact that placed the Task's current
 *   stage, or null when a person, an agent or the status placed it.
 *
 * The migration only adds tables, columns and indexes, so the upgrade test
 * needs no fixture for it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE task_entity_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id BLOB NOT NULL REFERENCES tasks (id),
      ref TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('open', 'completed', 'abandoned')),
      previous_lifecycle TEXT
        CHECK (previous_lifecycle IS NULL OR previous_lifecycle IN ('open', 'completed', 'abandoned')),
      observed_at TEXT NOT NULL,
      voided_at TEXT
    )
  `;
  yield* sql`CREATE INDEX task_entity_facts_task_ref ON task_entity_facts (task_id, ref, id)`;

  yield* sql`
    CREATE TABLE task_entity_link_suppressions (
      task_id BLOB NOT NULL REFERENCES tasks (id),
      ref TEXT NOT NULL,
      suppressed_at TEXT NOT NULL,
      suppressed_by TEXT NOT NULL,
      PRIMARY KEY (task_id, ref)
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE TABLE shipped_workflows (
      key TEXT PRIMARY KEY NOT NULL,
      workflow_id BLOB NOT NULL,
      installed_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE TABLE tracked_branch_attempts (
      connection_id BLOB NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
      remote TEXT NOT NULL,
      branch TEXT NOT NULL,
      last_attempted_at TEXT NOT NULL,
      PRIMARY KEY (connection_id, remote, branch)
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE INDEX external_entities_head ON external_entities (
      json_extract(repository, '$.head.remote'),
      json_extract(repository, '$.head.branch')
    ) WHERE json_extract(repository, '$.head.branch') IS NOT NULL
  `;

  yield* sql`ALTER TABLE external_entities ADD COLUMN source_created_at TEXT`;

  yield* sql`ALTER TABLE tasks ADD COLUMN stage_fact_fence INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE tasks ADD COLUMN stage_cause_fact_id INTEGER`;
});
