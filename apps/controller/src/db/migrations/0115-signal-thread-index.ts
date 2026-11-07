/**
 * Prepares signals to live inside their External Entity, and gives an entity a
 * timeline.
 *
 * - `signals_open_thread_ref` serves the join of a signal to its entity by
 *   ref alone, with no Connection. The older `signals_open_thread` starts with
 *   `connection_id`, so it cannot answer that lookup. The partial index holds
 *   only open signals, so it stays small.
 * - `external_entity_timeline` has one row per thing that changed at the
 *   source: someone else was assigned (`reassigned`), the status changed
 *   (`moved`), or a new link arrived (`linked`). `person` and `value` hold the
 *   raw words the sentence is built from when the timeline is read. It keys on
 *   the ref, not on an entity, so a row outlives the pruning of the entity
 *   until the entity's rows are deleted with it. The index on `(ref, id)`
 *   serves a ref's newest rows.
 * - `external_entities.reason_templates` is a copy of the kind's raw `reasons`
 *   table (`{ key: { say, tone } }`), made when the thing is observed, as
 *   `concern_reasons` is. A card's sentence for a signal, and the words of a
 *   timeline row, are built from it, so they read well after the plugin is
 *   gone.
 *
 * The migration only adds an index, a table and a column, so the upgrade test
 * needs no fixture for it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX signals_open_thread_ref ON signals (thread_ref)
    WHERE status = 'open'
  `;

  yield* sql`
    CREATE TABLE external_entity_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('reassigned', 'moved', 'linked')),
      person TEXT,
      value TEXT,
      observed_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX external_entity_timeline_ref ON external_entity_timeline (ref, id)`;

  yield* sql`
    ALTER TABLE external_entities
      ADD COLUMN reason_templates TEXT CHECK (reason_templates IS NULL OR json_valid(reason_templates))
  `;
});
