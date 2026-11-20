/**
 * Adds the three columns that mark an archived Wiki Page (spec 19 section
 * 2.3): when it was archived, by whom and why. All three are NULL on a page
 * that is not archived, and `wikiPage.restore` sets them back to NULL.
 *
 * Every existing page gets NULL: no page could be archived before this.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE wiki_pages ADD COLUMN archived_at TEXT`;
  yield* sql`ALTER TABLE wiki_pages ADD COLUMN archived_by TEXT`;
  yield* sql`ALTER TABLE wiki_pages ADD COLUMN archive_reason TEXT`;
});
