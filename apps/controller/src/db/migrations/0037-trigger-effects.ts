/**
 * Adds what routing events to start triggers needs (spec 07 section 2,
 * spec 08 section 3):
 *
 * - `trigger_effects`: one row per start trigger that matched an event. The
 *   event router writes it as `pending` in the transaction that matched the
 *   event, and the delivery that starts runs moves it to `spawned` with the id
 *   of the run it started, or to `discarded` when its run can never start.
 *   The unique key makes routing one event twice harmless: the second insert
 *   is ignored instead of starting a second run. `id` orders the rows by
 *   arrival, so runs start in the order their events matched.
 * - Columns on `triggers`: the start trigger's input mapping, its health and
 *   the stage it failed at, and a cron trigger's schedule state
 *   (`next_fire_at`, the zone that time was computed in, `last_fired_at`, and
 *   the latest stretch of missed times). The input mapping of every start
 *   trigger saved before is copied from its workflow's stored definition, so
 *   those triggers start their runs with the inputs they declare.
 * - `runs.trigger_event`: the copy of the event that started a run.
 * - `events_dedup` gains `source`. The Scheduler writes each `cron.tick` with
 *   a dedup key anyone can compute, and `event.emit` lets a caller choose the
 *   key of a manual event. With `source` in the key, a manual event can no
 *   longer take a tick's key first and stop the tick from being written.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE trigger_effects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id BLOB NOT NULL,
      trigger_id TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'spawned', 'discarded')),
      inputs TEXT NOT NULL CHECK (json_valid(inputs)),
      run_id BLOB,
      matched_at TEXT NOT NULL,
      UNIQUE (workflow_id, trigger_id, event_id),
      FOREIGN KEY (workflow_id, trigger_id)
        REFERENCES triggers (workflow_id, trigger_id) ON DELETE CASCADE,
      CHECK ((state = 'spawned') = (run_id IS NOT NULL))
    )
  `;
  // Serves the delivery, which reads the pending rows in arrival order on
  // every tick. The index is partial, so it holds the few rows still waiting
  // and not the history of every run a trigger started.
  yield* sql`CREATE INDEX trigger_effects_pending ON trigger_effects (id) WHERE state = 'pending'`;

  yield* sql`ALTER TABLE triggers ADD COLUMN inputs TEXT CHECK (inputs IS NULL OR json_valid(inputs))`;
  yield* sql`
    UPDATE triggers SET inputs = (
      SELECT json_extract(declared.value, '$.inputs')
      FROM workflows, json_each(workflows.definition, '$.triggers') AS declared
      WHERE workflows.id = triggers.workflow_id
        AND json_extract(declared.value, '$.id') = triggers.trigger_id
    )
    WHERE kind = 'start'
  `;
  yield* sql`ALTER TABLE triggers ADD COLUMN health_error_message TEXT`;
  yield* sql`
    ALTER TABLE triggers ADD COLUMN health_error_stage TEXT
    CHECK (health_error_stage IN ('evaluation', 'scheduling', 'start'))
  `;
  // The three health columns are written together or not at all. The check
  // is on the last column because a table check cannot be added to a table
  // that already exists.
  yield* sql`
    ALTER TABLE triggers ADD COLUMN health_error_at TEXT
    CHECK ((health_error_message IS NULL) = (health_error_at IS NULL)
           AND (health_error_message IS NULL) = (health_error_stage IS NULL))
  `;
  yield* sql`ALTER TABLE triggers ADD COLUMN next_fire_at TEXT`;
  yield* sql`ALTER TABLE triggers ADD COLUMN next_fire_zone TEXT`;
  yield* sql`ALTER TABLE triggers ADD COLUMN last_fired_at TEXT`;
  yield* sql`ALTER TABLE triggers ADD COLUMN skipped_from TEXT`;
  yield* sql`
    ALTER TABLE triggers ADD COLUMN skipped_until TEXT
    CHECK ((skipped_from IS NULL) = (skipped_until IS NULL))
  `;
  // Serves the Scheduler, which looks for the cron triggers whose next time
  // has come on every tick. The index is partial, so it holds only the cron
  // triggers.
  yield* sql`
    CREATE INDEX triggers_cron_next_fire ON triggers (next_fire_at)
    WHERE kind = 'start' AND event_kind = 'cron.tick' AND schedule IS NOT NULL
  `;

  yield* sql`
    ALTER TABLE runs ADD COLUMN trigger_event TEXT
    CHECK (trigger_event IS NULL OR json_valid(trigger_event))
  `;

  yield* sql`DROP INDEX events_dedup`;
  yield* sql`
    CREATE UNIQUE INDEX events_dedup
      ON events (source, ifnull(connection_id, x''), dedup_key)
  `;
});
