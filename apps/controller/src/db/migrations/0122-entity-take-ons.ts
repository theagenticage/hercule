/**
 * Lets a Take on together of several External Entities be taken back by a
 * record the controller keeps.
 *
 * `entity_take_ons` has one row per `takeOnTogether` call: the Task it made
 * or joined (`task_id`, `task_created`), the links it wrote and the taken
 * marks it set, each with the time the row holds (`links_added` and
 * `marks_taken`, JSON lists of `{ ref, at }`), and when it was written. The
 * Undo reverses exactly that, and only while every row still holds the
 * recorded time. `undone_at` and `undo_result` (the answer, as JSON) are set
 * by the first Undo that takes the call back, and a repeat returns that
 * answer. Like `entity_handoffs`, its ids are not foreign keys: the record is
 * history and keeps the id of a Task deleted since.
 *
 * The migration only adds a table, so the upgrade test needs no fixture for it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE entity_take_ons (
      id BLOB PRIMARY KEY NOT NULL,
      task_id BLOB NOT NULL,
      task_created INTEGER NOT NULL CHECK (task_created IN (0, 1)),
      links_added TEXT NOT NULL CHECK (json_valid(links_added)),
      marks_taken TEXT NOT NULL CHECK (json_valid(marks_taken)),
      created_at TEXT NOT NULL,
      undone_at TEXT,
      undo_result TEXT CHECK (undo_result IS NULL OR json_valid(undo_result))
    ) WITHOUT ROWID
  `;
});
