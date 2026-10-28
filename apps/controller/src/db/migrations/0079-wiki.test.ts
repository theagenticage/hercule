/**
 * Tests the rules the Wiki migration puts in the tables themselves, on a
 * migrated temporary database:
 *
 * - a slug is unique within one Resource's Wiki, not across Wikis;
 * - a page may name a Resource that does not exist, because deleting a
 *   Resource deletes no page;
 * - both default listings read an index without sorting.
 *
 * The rows are written in plain SQL, so the tables' rules are tested on their
 * own rather than behind the service that already follows them.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { inTransaction, TestDatabase } from "../testing";

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestDatabase));

const at = "2026-10-14T00:00:00.000Z";

/** Two Resource ids. No Resource row exists for either. */
const RESOURCE_A = "0199e0e77b2170008000000000000a01";
const RESOURCE_B = "0199e0e77b2170008000000000000a02";

/**
 * Inserts one page with a fresh id and returns `accepted`, or SQLite's error
 * message when a constraint refuses the row.
 */
const insertPage = (resourceId: string, slug: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* Effect.match(
      inTransaction(
        sql`
          INSERT INTO wiki_pages
            (id, resource_id, repository, slug, title, summary, revision, updated_at, updated_by, created_at)
          VALUES
            (randomblob(16), ${sql.literal(`x'${resourceId}'`)}, 'github.com/acme/app', ${slug},
             'A title', 'A summary', 1, ${at}, 'user', ${at})`,
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

describe("the wiki tables", () => {
  it("accepts a page whose Resource does not exist", async () => {
    expect(await run(insertPage(RESOURCE_A, "architecture"))).toBe("accepted");
  });

  it("refuses a slug taken in the same Wiki and accepts it in another", async () => {
    const results = await run(
      Effect.all([
        insertPage(RESOURCE_A, "architecture"),
        insertPage(RESOURCE_A, "architecture"),
        insertPage(RESOURCE_B, "architecture"),
      ]),
    );

    expect(results[0]).toBe("accepted");
    expect(results[1]).toContain("UNIQUE constraint failed");
    expect(results[2]).toBe("accepted");
  });

  it("lists one Wiki newest change first from an index, without sorting", async () => {
    const plan = await run(
      explainQueryPlan(
        `SELECT id FROM wiki_pages WHERE resource_id = x'${RESOURCE_A}'
         ORDER BY updated_at DESC, id DESC`,
      ),
    );

    expect(plan).toMatch(/USING (COVERING )?INDEX wiki_pages_resource_updated\b/);
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("lists every Wiki newest change first from an index, without sorting", async () => {
    const plan = await run(
      explainQueryPlan(`SELECT id FROM wiki_pages ORDER BY updated_at DESC, id DESC`),
    );

    expect(plan).toMatch(/USING (COVERING )?INDEX wiki_pages_updated\b/);
    expect(plan).not.toContain("TEMP B-TREE");
  });
});
