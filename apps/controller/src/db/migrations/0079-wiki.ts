/**
 * Adds the Wiki (spec 19 §2.3): `wiki_pages`, one row per Wiki Page, and
 * `wiki_revisions`, every revision of every page.
 *
 * A Wiki is the set of pages of one repository Resource, so it has no table of
 * its own. A page's slug is unique within its Wiki.
 *
 * `resource_id` is not a foreign key. Deleting a Resource deletes no page:
 * the page keeps its `resource_id` and the `repository` copied at creation,
 * and stays readable, as every historical reference keeps the id of a deleted
 * row (spec 19 §3.2).
 *
 * Every write stores the whole page as a new revision, and a revision is never
 * changed or deleted. The page row repeats the current revision's title,
 * summary, time and actor, so listing pages reads only `wiki_pages`. The body
 * is stored only in `wiki_revisions`: it can be 64,000 characters, and a list
 * never shows it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE wiki_pages (
      id BLOB PRIMARY KEY NOT NULL,
      resource_id BLOB NOT NULL,
      repository TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (resource_id, slug)
    )
  `;
  // Serve the default listing, newest change first: one for a single Wiki and
  // one across every Wiki.
  yield* sql`CREATE INDEX wiki_pages_resource_updated ON wiki_pages (resource_id, updated_at, id)`;
  yield* sql`CREATE INDEX wiki_pages_updated ON wiki_pages (updated_at, id)`;
  // Serves a listing of every Wiki sorted by title, which would otherwise
  // sort the whole table. One Wiki holds at most 500 pages, so its own
  // listing by title needs no index.
  yield* sql`CREATE INDEX wiki_pages_title ON wiki_pages (title, id)`;

  // A rowid table rather than WITHOUT ROWID: a revision holds the whole body,
  // and SQLite advises against WITHOUT ROWID for rows that large.
  yield* sql`
    CREATE TABLE wiki_revisions (
      page_id BLOB NOT NULL REFERENCES wiki_pages (id),
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      actor TEXT NOT NULL,
      at TEXT NOT NULL,
      -- Last, because SQLite reads a large value's overflow pages to reach any
      -- column after it: the revision list reads the columns above and never
      -- walks a body.
      body TEXT NOT NULL,
      PRIMARY KEY (page_id, revision)
    )
  `;
});
