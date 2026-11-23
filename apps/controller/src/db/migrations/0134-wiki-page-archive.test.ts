/**
 * Tests the two rules the archive migration puts in the table itself, on a
 * migrated temporary database:
 *
 * - a page has all three archive columns or none of them;
 * - counting and listing one Wiki's pages that are not archived reads the
 *   index that holds only those, so archived pages cost those reads nothing;
 * - listing every page in creation order reads an index without sorting.
 *
 * The rows are written in plain SQL, so the table's rules are tested on their
 * own rather than behind the service that already follows them.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { inTransaction, TestDatabase } from "../testing";

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestDatabase));

/** A Resource id. No Resource row exists for it. */
const RESOURCE = "0199e0e77b2170008000000000000a01";

/**
 * Inserts one page whose archive columns are the SQL text `archiveValues`,
 * and returns `accepted`, or SQLite's error message when the check refuses it.
 */
const insertPage = (slug: string, archiveValues: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* Effect.match(
      inTransaction(
        sql`
          INSERT INTO wiki_pages
            (id, resource_id, repository, slug, title, summary, revision, updated_at, updated_by,
             created_at, archived_at, archived_by, archive_reason)
          VALUES
            (randomblob(16), ${sql.literal(`x'${RESOURCE}'`)}, 'github.com/acme/app', ${slug},
             'A title', 'A summary', 1, '2026-10-14T00:00:00.000Z', 'user',
             '2026-10-14T00:00:00.000Z', ${sql.literal(archiveValues)})`,
      ),
      {
        // The SQL error wraps a constraint error, which wraps SQLite's own
        // error, and only SQLite's message names the constraint.
        onFailure: (error) => String(error.cause.cause),
        onSuccess: () => "accepted",
      },
    );
  });

/** Returns SQLite's plan for a statement, its steps joined with " / ". */
const explainQueryPlan = (statement: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly detail: string }>`${sql.literal(`EXPLAIN QUERY PLAN ${statement}`)}`,
      (rows) => rows.map((row) => row.detail).join(" / "),
    ),
  );

describe("a wiki page's archive columns", () => {
  it("accepts a page with all three or none, and refuses one with only some", async () => {
    const results = await run(
      Effect.all([
        insertPage("current", "NULL, NULL, NULL"),
        insertPage("archived", "'2026-10-20T00:00:00.000Z', 'user', 'Out of date'"),
        insertPage("no-reason", "'2026-10-20T00:00:00.000Z', 'user', NULL"),
        insertPage("only-reason", "NULL, NULL, 'Out of date'"),
      ]),
    );

    expect(results.slice(0, 2)).toEqual(["accepted", "accepted"]);
    expect(results[2]).toContain("CHECK constraint failed");
    expect(results[3]).toContain("CHECK constraint failed");
  });

  it("counts and lists one Wiki's pages that are not archived from the index that holds only those", async () => {
    const [count, listing] = await run(
      Effect.all([
        explainQueryPlan(
          `SELECT count(*) FROM wiki_pages WHERE resource_id = x'${RESOURCE}' AND archived_at IS NULL`,
        ),
        explainQueryPlan(
          `SELECT id FROM wiki_pages WHERE resource_id = x'${RESOURCE}' AND archived_at IS NULL
           ORDER BY updated_at DESC, id DESC`,
        ),
      ]),
    );

    expect(count).toContain("wiki_pages_current_resource_updated");
    expect(listing).toContain("wiki_pages_current_resource_updated");
    expect(listing).not.toContain("TEMP B-TREE");
  });

  it("lists every page in creation order from an index, without sorting", async () => {
    const plan = await run(
      explainQueryPlan(`SELECT id FROM wiki_pages ORDER BY created_at ASC, id ASC`),
    );

    expect(plan).toContain("wiki_pages_created");
    expect(plan).not.toContain("TEMP B-TREE");
  });
});
