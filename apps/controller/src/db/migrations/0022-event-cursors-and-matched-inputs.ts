/**
 * How far a durable consumer of the event log has read, and which event woke
 * which session.
 *
 * A consumer walks the log by position: `position` is the id of the last entry
 * it has finished with, so a consumer whose process stops mid-pass starts
 * again at the entry after it. The row is created at position 0 and ids count
 * from one, so a consumer that has never run reads the whole log. The table is
 * keyed by the consumer's name because a second consumer of the same log is a
 * second row and nothing else.
 *
 * `session_inputs` gains the two columns saying what an input row came from,
 * and they are written together or not at all. Spec 08 calls a row written
 * this way the effect row; in this database it is an input like any other,
 * told apart by the subscription and the event it names.
 * The unique index over the pair is what makes a second pass over the same
 * entries harmless: a consumer that committed its input rows and stopped
 * before it advanced its cursor reads those entries again, and the second
 * insert is turned away instead of waking a session twice for one fact. The
 * index is partial because an input a person typed names no subscription, and
 * several of those on one session must stay allowed.
 *
 * No foreign key, for the reason migration 0010 gives: these rows are history
 * and outlive what they name.
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
  // The two columns are one fact and are written together or not at all. The
  // constraint is carried by the second column because SQLite evaluates a
  // column check over the whole row, and a table check cannot be added to a
  // table that already exists.
  yield* sql`
    ALTER TABLE session_inputs ADD COLUMN event_id INTEGER
    CHECK ((subscription_id IS NULL) = (event_id IS NULL))
  `;

  yield* sql`
    CREATE UNIQUE INDEX session_inputs_match ON session_inputs (subscription_id, event_id)
    WHERE subscription_id IS NOT NULL
  `;

  // Every tick asks which sessions hold a matched input nothing
  // has sent yet. The index is partial over exactly that question, so it holds
  // the few rows still owed and not the delivered history beside them: it stays
  // the same size as the work outstanding while the table grows for ever.
  yield* sql`
    CREATE INDEX session_inputs_awaiting ON session_inputs (session_id)
    WHERE source = 'subscription' AND status = 'queued' AND sent_at IS NULL
  `;
});
