/**
 * Adds `signals`: what Intake puts in front of the user because a move is
 * asked of them (spec 10 §9), and `signal_events`, the events each signal is
 * about.
 *
 * The origin, the blocks, the actions, the match values, the task, the Ignore
 * Rule and the resolution are JSON columns. A signal is read and written
 * whole, and nothing but its resolution changes after it is written, so a
 * child table per list would add joins and buy nothing.
 *
 * The event ids are the exception: they get a child table, because a later
 * prune of the event log must find the events a signal still names, and that
 * lookup needs an index. `event_id` is not a foreign key: the event log is
 * pruned, and a signal keeps the ids of the events it was raised from.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE signals (
      id BLOB PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (json_valid(origin)),
      title TEXT NOT NULL,
      asker TEXT,
      place TEXT,
      priority TEXT NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
      blocks TEXT NOT NULL CHECK (json_valid(blocks)),
      actions TEXT NOT NULL CHECK (json_valid(actions)),
      match TEXT NOT NULL CHECK (json_valid(match)),
      build_error TEXT CHECK (build_error IS NULL OR json_valid(build_error)),
      task TEXT CHECK (task IS NULL OR json_valid(task)),
      ignore_rule TEXT CHECK (ignore_rule IS NULL OR json_valid(ignore_rule)),
      status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
      resolution TEXT CHECK (resolution IS NULL OR json_valid(resolution)),
      replaced_by BLOB,
      created_at TEXT NOT NULL,
      -- An open signal has no resolution yet, and a resolved one always has.
      CHECK ((status = 'open') = (resolution IS NULL))
    )
  `;
  // Serves the to-do view: every open signal, oldest first. Open signals are
  // few, so the partial index stays small however many resolved ones pile up.
  yield* sql`CREATE INDEX signals_open ON signals (created_at, id) WHERE status = 'open'`;

  yield* sql`
    CREATE TABLE signal_events (
      signal_id BLOB NOT NULL REFERENCES signals (id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL,
      PRIMARY KEY (signal_id, event_id)
    ) WITHOUT ROWID
  `;
  // Serves a prune of the event log, which must keep every event a signal names.
  yield* sql`CREATE INDEX signal_events_event ON signal_events (event_id)`;
});
