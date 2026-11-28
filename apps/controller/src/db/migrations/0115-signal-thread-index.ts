/**
 * Prepares signals to live inside their External Entity, and gives an entity a
 * timeline.
 *
 * - `signals_thread_ref` serves the join of a signal to its entity by ref
 *   alone, with no Connection, for open and resolved signals alike. The older
 *   `signals_open_thread` starts with `connection_id`, so it cannot answer
 *   that lookup, and every other signal index is partial on open signals. The
 *   card reads open signals by ref, and the detail also counts and lists the
 *   resolved ones. `status` is the second column so a card's read seeks only
 *   its open signals, however many resolved ones the ref has. `created_at`
 *   and `id` follow, so the detail reads the newest lines of one status
 *   straight off the index, with no sort, and counts them without reading the
 *   signals.
 * - `external_entity_timeline` has one row per thing that changed at the
 *   source: someone else was assigned (`reassigned`), the status changed
 *   (`moved`), or a new link arrived (`linked`). `person` (the new owner of a
 *   `reassigned` row, null when the owner was cleared) and `value` (the new
 *   status word of a `moved` row) hold the raw words the sentence is built
 *   from when the timeline is read. For a `linked` row, `target_ref` is the
 *   ref of the thing that was linked, so a client can draw its mark and open
 *   it. A `linked` row stores no words of the far end: they are worked out
 *   when the row is read, so a thing the user can no longer open is not
 *   named. It keys on the ref, not on an entity, so a row outlives the
 *   pruning of the entity until the entity's rows are deleted with it. The index on `(ref, id)`
 *   serves a ref's newest rows.
 * - `external_entities.status_key` is the key of the thing's status in the
 *   kind's status table, such as `in_review`. The status column holds only
 *   the word and look the user sees, which a plugin may rename, so the
 *   timeline compares keys to tell a real move from a renamed word. It is
 *   null for a thing with no status.
 * - `external_entities.reason_templates` is a copy of the kind's raw `reasons`
 *   table (`{ key: { say, tone } }`), made when the thing is observed, as
 *   `concern_reasons` is. A card's sentence for a signal, and the words of a
 *   timeline row, are built from it, so they read well after the plugin is
 *   gone.
 * - `external_entity_relation_claims` gains what a claim needs to be found
 *   again and to be resolved. A pending claim names a thing only by how a
 *   plugin recognized it (`unresolved:...`), so it is not a ref yet:
 *   `is_pending` is true while `to_ref` holds such a target, and every read of
 *   links filters on it. `recognized_as` is the target as the recognizer first
 *   named it, so a text claim that was resolved to a ref is still matched by
 *   what its text says. `resolve_attempts` and `next_resolve_at` are the
 *   backoff of the resolver loop, like the ones on observations ('' is due
 *   now, and sorts before every time). `in_baseline` is true for a claim
 *   written while its thing was not yet a full record: what a thing arrived
 *   with is not news, however late a pending claim of it resolves.
 *
 * The migration only adds indexes, tables and columns, so the upgrade test
 * needs no fixture for it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX signals_thread_ref ON signals (thread_ref, status, created_at, id)
  `;

  yield* sql`
    CREATE TABLE external_entity_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('reassigned', 'moved', 'linked')),
      person TEXT,
      value TEXT,
      target_ref TEXT,
      observed_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX external_entity_timeline_ref ON external_entity_timeline (ref, id)`;

  yield* sql`
    ALTER TABLE external_entities
      ADD COLUMN reason_templates TEXT CHECK (reason_templates IS NULL OR json_valid(reason_templates))
  `;

  yield* sql`ALTER TABLE external_entities ADD COLUMN status_key TEXT`;

  yield* sql`ALTER TABLE external_entity_relation_claims ADD COLUMN recognized_as TEXT`;
  yield* sql`
    ALTER TABLE external_entity_relation_claims
      ADD COLUMN resolve_attempts INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    ALTER TABLE external_entity_relation_claims
      ADD COLUMN next_resolve_at TEXT NOT NULL DEFAULT ''`;
  yield* sql`
    ALTER TABLE external_entity_relation_claims
      ADD COLUMN in_baseline INTEGER NOT NULL DEFAULT 0 CHECK (in_baseline IN (0, 1))`;
  yield* sql`
    ALTER TABLE external_entity_relation_claims
      ADD COLUMN is_pending INTEGER GENERATED ALWAYS AS (substr(to_ref, 1, 11) = 'unresolved:') VIRTUAL`;
  // Serves the resolver loop: the oldest due pending claims, in the order
  // they are tried, without a sort. With nothing pending, the index is empty.
  yield* sql`
    CREATE INDEX external_entity_claims_pending
      ON external_entity_relation_claims (next_resolve_at, id) WHERE is_pending = 1
  `;
});
