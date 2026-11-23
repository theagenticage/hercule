/**
 * Adds the three columns that mark an archived Wiki Page (spec 19 section
 * 2.3): when it was archived, by whom and why. All three are NULL on a page
 * that is not archived, and `wikiPage.restore` sets them back to NULL. The
 * check on the last column refuses a row that has some of the three and not
 * the others.
 *
 * Every existing page gets NULL: no page could be archived before this.
 *
 * Two indexes:
 *
 * - one holds only the pages that are not archived. The page count and the
 *   prompt line read those pages of one Wiki at every session start, and
 *   archived pages are never removed, so without it both would walk every
 *   page the Wiki ever archived;
 * - one serves a listing of every Wiki in the order the pages were created.
 *   The CLI reads that listing to find the page an id tail names, in this
 *   order because a page's creation time never changes while it reads.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE wiki_pages ADD COLUMN archived_at TEXT`;
  yield* sql`ALTER TABLE wiki_pages ADD COLUMN archived_by TEXT`;
  yield* sql`
    ALTER TABLE wiki_pages ADD COLUMN archive_reason TEXT CHECK (
      (archived_at IS NULL) = (archived_by IS NULL)
      AND (archived_at IS NULL) = (archive_reason IS NULL)
    )
  `;
  yield* sql`
    CREATE INDEX wiki_pages_current_resource_updated
    ON wiki_pages (resource_id, updated_at, id) WHERE archived_at IS NULL
  `;
  yield* sql`CREATE INDEX wiki_pages_created ON wiki_pages (created_at, id)`;
});
