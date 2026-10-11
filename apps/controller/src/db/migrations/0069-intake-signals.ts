/**
 * Adds what raising a plugin's signals from its events needs (spec 10 §9.2):
 *
 * - `events.title` and `events.author`: the one-line title every emitted
 *   event carries, and who caused it. An event written before this
 *   migration, or by the core, has neither, so both stay null.
 * - `connections.warning`: the sentence a Connection type's `validate`
 *   returned with the account, when the credentials work but cost the user
 *   something.
 * - `signals.connection_id` and `signals.thread_ref`: the Connection and the
 *   thread a signal raised from an event is about. They copy two fields of
 *   the signal's `origin`, so an end on the source and a replacement find the
 *   open signal on a thread with an index rather than by reading every
 *   origin. A signal raised through `signal.raise` has neither.
 * - `signal_raises`: the outbox between the event router and the step that
 *   raises the signal. The router writes a row in its own transaction when a
 *   kind's rule returns `yes` or `undecided`, and the step after the commit
 *   reads it, calls the plugin's `build`, and writes the signal. `build` may
 *   call the source, so it can never run inside the router's transaction.
 *   The row keeps the Connection and the thread too, so an end the router
 *   sees before the step has run can drop the raise it makes pointless.
 * - an index on the signals whose `build` failed, by kind, so the count the
 *   build-failed Notification shows reads only those few rows.
 * - an index on the event id of `session_inputs` and of `run_steps`, so the
 *   known-work check (a live Subscription received this event) is a lookup
 *   rather than a scan of every input and step.
 *
 * `signal_raises.event_id` is not a foreign key, like `signal_events.event_id`:
 * a row lives for one tick of the pipeline, and the event log's retention
 * never removes an event that young.
 *
 * Every change adds a table, a column or an index, so no existing row is
 * rewritten.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE events ADD COLUMN title TEXT`;
  yield* sql`ALTER TABLE events ADD COLUMN author TEXT`;

  yield* sql`ALTER TABLE connections ADD COLUMN warning TEXT`;

  yield* sql`ALTER TABLE signals ADD COLUMN connection_id BLOB`;
  yield* sql`ALTER TABLE signals ADD COLUMN thread_ref TEXT`;
  yield* sql`
    CREATE INDEX signals_open_thread ON signals (connection_id, thread_ref)
    WHERE status = 'open'
  `;

  yield* sql`CREATE INDEX signals_build_failed ON signals (kind) WHERE build_error IS NOT NULL`;

  yield* sql`
    CREATE TABLE signal_raises (
      event_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('yes', 'undecided')),
      connection_id BLOB NOT NULL,
      thread_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (event_id, kind)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX signal_raises_thread ON signal_raises (connection_id, thread_ref, kind)
  `;

  yield* sql`
    CREATE INDEX session_inputs_event ON session_inputs (event_id) WHERE event_id IS NOT NULL
  `;
  yield* sql`CREATE INDEX run_steps_event ON run_steps (event_id) WHERE event_id IS NOT NULL`;
});
