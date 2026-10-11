/**
 * Adds what Intake's Done, Snooze and Not urgent moves store.
 *
 * - `signal_snoozes` holds one row per snoozed signal: the time it comes back
 *   (`until`, a UTC ISO time), when it was snoozed and who snoozed it. A row
 *   whose `until` has passed stays until the signal is resolved or unsnoozed;
 *   the to-do view compares `until` with the time of the read, so no timer is
 *   needed. The `(until, signal_id)` index serves the Later view's order.
 * - `signals.priority_lowered` records that the user moved a signal to Not
 *   urgent, so a replacement raised by the same kind can keep that choice.
 * - `signals.resolved_at` is the resolution's time, read out of the JSON
 *   `resolution` column. A keyset seek works only on plain columns, so the
 *   Done view's order, newest resolution first, needs this virtual column and
 *   the partial index over resolved signals. A second partial index leads
 *   with the kind, so the Done view of one kind, or of one plugin's kinds,
 *   reads only that kind's rows instead of all of history.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE signal_snoozes (
      signal_id BLOB PRIMARY KEY REFERENCES signals(id) ON DELETE CASCADE,
      until TEXT NOT NULL,
      snoozed_at TEXT NOT NULL,
      actor TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX signal_snoozes_until ON signal_snoozes (until, signal_id)`;

  yield* sql`ALTER TABLE signals ADD COLUMN priority_lowered INTEGER NOT NULL DEFAULT 0`;

  // The guard keeps text that is not JSON from failing inside json_extract,
  // so the resolution column's own check refuses it and names the column.
  yield* sql`
    ALTER TABLE signals ADD COLUMN resolved_at TEXT GENERATED ALWAYS AS (
      CASE WHEN json_valid(resolution) THEN json_extract(resolution, '$.at') END
    ) VIRTUAL
  `;
  yield* sql`
    CREATE INDEX signals_resolved ON signals (resolved_at DESC, id DESC) WHERE status = 'resolved'
  `;
  yield* sql`
    CREATE INDEX signals_resolved_kind ON signals (kind, resolved_at DESC, id DESC)
    WHERE status = 'resolved'
  `;
});
