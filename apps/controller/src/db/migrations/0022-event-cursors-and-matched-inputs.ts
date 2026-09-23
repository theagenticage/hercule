/**
 * How far a durable consumer of the event log has read, and which event woke
 * which session.
 *
 * A consumer reads the log in order of position: `position` is the id of the
 * last entry it has finished with, so a consumer whose process stops halfway
 * starts again at the next entry. The row is created at position 0 and ids
 * start at one, so a consumer that has never run reads the whole log. The
 * table is keyed by the consumer's name, so a second consumer of the same log
 * is just a second row.
 *
 * `session_inputs` gains two columns that record what an input row came from,
 * and they are written together or not at all. Spec 08 calls a row written
 * this way the effect row; in this database it is an input like any other,
 * told apart by its subscription and event.
 *
 * The unique index over the pair makes a second pass over the same entries
 * harmless. A consumer that committed its input rows and stopped before it
 * advanced its cursor reads those entries again, and the second insert is
 * rejected instead of waking a session twice for one event. The index is
 * partial because an input a person typed has no subscription, and one session
 * can have several of those.
 *
 * No foreign key, for the reason explained in migration 0010: these rows are
 * history and outlive what they refer to.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE event_cursors (
      consumer TEXT PRIMARY KEY NOT NULL,
      position INTEGER NOT NULL
    )
  `;

  yield* sql`ALTER TABLE session_inputs ADD COLUMN subscription_id BLOB`;
  // The two columns belong together and are written together or not at all.
  // The constraint is on the second column because SQLite evaluates a column
  // check over the whole row, and a table check cannot be added to a table
  // that already exists.
  yield* sql`
    ALTER TABLE session_inputs ADD COLUMN event_id INTEGER
    CHECK ((subscription_id IS NULL) = (event_id IS NULL))
  `;

  yield* sql`
    CREATE UNIQUE INDEX session_inputs_match ON session_inputs (subscription_id, event_id)
    WHERE subscription_id IS NOT NULL
  `;

  // Every tick looks for sessions with a queued input that has not been sent
  // yet, whatever wrote it. The index is partial over exactly those rows, so it
  // holds the few inputs still waiting and not the delivered history. It stays
  // the size of the outstanding work while the table grows for ever.
  yield* sql`
    CREATE INDEX session_inputs_awaiting ON session_inputs (session_id)
    WHERE status = 'queued' AND sent_at IS NULL
  `;
});
