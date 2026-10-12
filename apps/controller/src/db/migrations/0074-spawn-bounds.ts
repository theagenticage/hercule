/**
 * Adds what spawn bounds and invalid workflows need (spec 10 section 5,
 * spec 07 section 2.5):
 *
 * - `trigger_effects` gains the state `held`: an event the trigger matched
 *   and keeps, instead of starting a run, until the trigger is resumed and
 *   its window has room. It also gains `spawned_at`, when the row's run
 *   started, because the sliding window counts runs by when they started,
 *   not by when their event matched. A held event that starts a run hours
 *   after it matched must still count against the window it started in.
 *   Every row already spawned takes its run's `created_at`, which is when
 *   the delivery started it: usually within a routing tick of the match, but
 *   later when the controller was stopped in between. A row whose run is gone
 *   takes its `matched_at`, the closest time left.
 * - `triggers.paused_by`: who paused a start trigger, `manual` or `breaker`.
 *   Every trigger paused before this migration was paused manually, because
 *   nothing else could pause one.
 * - `triggers.spawn_bound_max_runs` and `spawn_bound_window_seconds`: the
 *   spawn bound the source sets for a start trigger, or NULL when it sets
 *   none and the default applies. They copy the bound from the stored
 *   definition, so that the event router does not parse every definition on
 *   every pass. A save writes them with the trigger's other columns.
 * - `triggers.held_at_resume`: how many events the trigger held right after
 *   it was last resumed. A trigger whose held events grow by more than its
 *   bound beyond that count trips the breaker again.
 * - `workflows.invalid_since`: when a stored workflow stopped validating,
 *   because a plugin, agent or Connection it uses changed after it was
 *   saved. Null while it is valid, which every stored workflow was when it
 *   was saved. The controller validates them all again when it starts.
 *
 * `trigger_effects` is rebuilt rather than altered, because SQLite cannot
 * widen a CHECK in place. Its other columns and constraints are unchanged.
 * Nothing references the table.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE trigger_effects_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id BLOB NOT NULL,
      trigger_id TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'held', 'spawned', 'discarded')),
      inputs TEXT NOT NULL CHECK (json_valid(inputs)),
      run_id BLOB,
      matched_at TEXT NOT NULL,
      spawned_at TEXT,
      UNIQUE (workflow_id, trigger_id, event_id),
      FOREIGN KEY (workflow_id, trigger_id)
        REFERENCES triggers (workflow_id, trigger_id) ON DELETE CASCADE,
      CHECK ((state = 'spawned') = (run_id IS NOT NULL)),
      CHECK ((state = 'spawned') = (spawned_at IS NOT NULL))
    )
  `;
  yield* sql`
    INSERT INTO trigger_effects_new
      (id, workflow_id, trigger_id, event_id, state, inputs, run_id, matched_at, spawned_at)
    SELECT
      id, workflow_id, trigger_id, event_id, state, inputs, run_id, matched_at,
      CASE WHEN state = 'spawned' THEN COALESCE(
        (SELECT runs.created_at FROM runs WHERE runs.id = trigger_effects.run_id),
        matched_at
      ) END
    FROM trigger_effects
  `;
  yield* sql`DROP TABLE trigger_effects`;
  yield* sql`ALTER TABLE trigger_effects_new RENAME TO trigger_effects`;

  // Serves the delivery, which reads every pending row in the order the rows
  // were written.
  yield* sql`CREATE INDEX trigger_effects_pending ON trigger_effects (id) WHERE state = 'pending'`;
  // Serves the matcher and the spawner, which read one trigger's held rows
  // in arrival order, and the held count on every trigger in the list.
  yield* sql`
    CREATE INDEX trigger_effects_held ON trigger_effects (workflow_id, trigger_id, id)
    WHERE state = 'held'
  `;
  // Serves the sliding window: one trigger's runs started since a time.
  yield* sql`
    CREATE INDEX trigger_effects_spawned ON trigger_effects (workflow_id, trigger_id, spawned_at)
    WHERE state = 'spawned'
  `;

  // Serves the sliding window's count of one trigger's pending rows.
  yield* sql`
    CREATE INDEX trigger_effects_pending_by_trigger ON trigger_effects (workflow_id, trigger_id)
    WHERE state = 'pending'
  `;

  // A table check cannot be added to a table that already exists, and a
  // column check is tested against the rows already there, before the
  // backfill below. So the check only refuses `paused_by` on a trigger that
  // is not paused, and the code writes the two columns together.
  yield* sql`
    ALTER TABLE triggers ADD COLUMN paused_by TEXT
    CHECK (paused_by IS NULL OR (status = 'paused' AND paused_by IN ('manual', 'breaker')))
  `;
  yield* sql`UPDATE triggers SET paused_by = 'manual' WHERE status = 'paused'`;

  // A spawn bound has both of its numbers or neither, and only a start
  // trigger has one. The check names the window column, so that column is
  // added first.
  yield* sql`ALTER TABLE triggers ADD COLUMN spawn_bound_window_seconds INTEGER`;
  yield* sql`
    ALTER TABLE triggers ADD COLUMN spawn_bound_max_runs INTEGER
    CHECK ((spawn_bound_max_runs IS NULL) = (spawn_bound_window_seconds IS NULL)
           AND (spawn_bound_max_runs IS NULL OR kind = 'start'))
  `;
  // The bounds are copied from the stored definitions. An older controller
  // accepted any positive bound, so each number is clamped to the most a
  // save accepts now: 10000 runs (MAX_SPAWN_BOUND_RUNS) in 30 days
  // (MAX_SPAWN_BOUND_WINDOW_SECONDS). A larger window would put its start
  // before any time SQLite can write. The definition keeps the number it
  // had, so the workflow fails to validate at boot and its author is told.
  // A definition never declares two triggers with one id.
  yield* sql`
    UPDATE triggers SET
      spawn_bound_max_runs = min(declared.max_runs, 10000),
      spawn_bound_window_seconds = min(declared.window_seconds, 2592000)
    FROM (
      SELECT workflows.id AS workflow_id,
             json_extract(trigger.value, '$.id') AS trigger_id,
             json_extract(trigger.value, '$.spawnBound.maxRuns') AS max_runs,
             json_extract(trigger.value, '$.spawnBound.windowSeconds') AS window_seconds
      FROM workflows, json_each(workflows.definition, '$.triggers') AS trigger
      WHERE json_extract(trigger.value, '$.spawnBound') IS NOT NULL
    ) AS declared
    WHERE triggers.kind = 'start'
      AND triggers.workflow_id = declared.workflow_id
      AND triggers.trigger_id = declared.trigger_id
  `;

  // NULL until the trigger is first resumed, or until the delivery holds one
  // of its pending events again because a save lowered its bound. Only
  // those two let an active trigger hold events, so the code never compares
  // against a NULL.
  yield* sql`ALTER TABLE triggers ADD COLUMN held_at_resume INTEGER`;

  yield* sql`ALTER TABLE workflows ADD COLUMN invalid_since TEXT`;
});
