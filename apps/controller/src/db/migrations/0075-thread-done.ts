/**
 * Adds the columns that record a Thread marked Done (spec 02, Done):
 *
 * - `done_at` and `done_by`: when the Thread was marked Done and the actor
 *   who marked it. Both are set together and cleared together, so a check
 *   refuses a row with only one of them;
 * - `reopened_at`: the last time the Thread was reopened, by `session.reopen`
 *   or by new input while it was Done. It stays set after the Thread is
 *   marked Done again, because a client sorts Threads on it.
 *
 * Every existing session gets `NULL` in all three: no Thread was Done before
 * this migration. The migration only adds nullable columns and rewrites no
 * row, so the upgrade test (`e2e/upgrade.test.ts`) needs no new fixture.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE sessions ADD COLUMN done_at TEXT`;
  yield* sql`
    ALTER TABLE sessions ADD COLUMN done_by TEXT
      CHECK ((done_by IS NULL) = (done_at IS NULL))
  `;
  yield* sql`ALTER TABLE sessions ADD COLUMN reopened_at TEXT`;
});
