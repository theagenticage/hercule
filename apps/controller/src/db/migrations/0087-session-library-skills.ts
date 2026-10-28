/**
 * Adds `sessions.library_skills`: the library skills the session got when its
 * start was last claimed, as a JSON array of `{ name, revisionHash,
 * description }`, or null (spec 06 section 9.4).
 *
 * The description is stored beside the name and hash because deleting a Skill
 * deletes its revisions, while a running session still has the skill on its
 * disk. Null means the session's start was never claimed; a session whose
 * runner did not load skills holds an empty array.
 *
 * The column is nullable and every existing session starts with null.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE sessions ADD COLUMN library_skills TEXT`;
});
