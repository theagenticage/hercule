/**
 * Records on each Task link when the user took the thing on, and indexes the
 * entity kind.
 *
 * `task_entity_links.taken_at` is the time the user took the thing on, and
 * null when they did not. Take on and Add to Work set it, both when they make
 * the Task and when they join a Task that something else made (a hand-off, a
 * session, a signal, an event). The Inbox uses it to decide that the user has
 * taken an ask on: an ask raised before `taken_at` stops asking.
 *
 * `task_entity_links.taken_by` is the actor who took it on, written with
 * `taken_at`. It is apart from `linked_by`, because a link a session made and
 * the user later took on keeps its original author.
 *
 * No existing link is marked. The evidence of an old Take on is ambiguous, and
 * hiding an ask on a guess is worse than showing it once more. The column
 * starts null and nothing is rewritten.
 *
 * `external_entities_kind` serves the Inbox's known facet values, which read
 * the context records of one kind.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE task_entity_links ADD COLUMN taken_at TEXT`;
  yield* sql`ALTER TABLE task_entity_links ADD COLUMN taken_by TEXT`;
  yield* sql`CREATE INDEX external_entities_kind ON external_entities (kind)`;
});
