/**
 * Tests the rules the notifications migration puts in the table itself, on a
 * migrated in-memory database:
 *
 * - an open decision has no resolution yet;
 * - an informational notification, one with no actions, is resolved from the
 *   start, and its only possible resolution is `handled`;
 * - the JSON columns hold valid JSON;
 * - the list and the lookup of open decisions each read an index without
 *   sorting.
 *
 * The rows are written in plain SQL, so the table's checks are tested on their
 * own rather than behind the service that already follows them.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "../testing";

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestDatabase));

const at = "2026-09-01T00:00:00.000Z";

const ACTIONS = JSON.stringify([{ id: "dismiss", label: "Dismiss", operation: null }]);
const RESOLUTION = JSON.stringify({ kind: "withdrawn", actor: "system", origin: "core", at });
const HANDLED = JSON.stringify({
  kind: "handled",
  actor: "system",
  origin: "core",
  conversationId: "0199e0e7-0000-7000-8000-00000000c001",
  at,
});

/** The columns a test sets; every other column gets a valid value. */
interface Row {
  readonly status: string;
  readonly actions: string;
  readonly resolution: string | null;
  readonly producer?: string;
  readonly subject?: string;
}

/**
 * Inserts one notification row and returns `accepted`, or the database's
 * error message when a constraint refuses the row.
 */
const insertRow = (row: Row) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* Effect.match(
      sql`
        INSERT INTO notifications
          (id, kind, title, producer, subject, actions, status, resolution, created_at)
        VALUES
          (randomblob(16), 'triage.proposal', 'a title', ${row.producer ?? '{"type":"core"}'},
           ${row.subject ?? "[]"}, ${row.actions}, ${row.status}, ${row.resolution}, ${at})`,
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

describe("the notifications table", () => {
  it("accepts an open decision, a resolved decision, and an informational notification, handled or not", async () => {
    const results = await run(
      Effect.all([
        insertRow({ status: "open", actions: ACTIONS, resolution: null }),
        insertRow({ status: "resolved", actions: ACTIONS, resolution: RESOLUTION }),
        insertRow({ status: "resolved", actions: "[]", resolution: null }),
        insertRow({ status: "resolved", actions: "[]", resolution: HANDLED }),
      ]),
    );

    expect(results).toEqual(["accepted", "accepted", "accepted", "accepted"]);
  });

  it("refuses a resolution on an open decision", async () => {
    expect(
      await run(insertRow({ status: "open", actions: ACTIONS, resolution: RESOLUTION })),
    ).toContain("CHECK constraint failed");
  });

  it("refuses an informational notification that is open, or that has a resolution other than handled", async () => {
    const results = await run(
      Effect.all([
        insertRow({ status: "open", actions: "[]", resolution: null }),
        insertRow({ status: "resolved", actions: "[]", resolution: RESOLUTION }),
      ]),
    );

    for (const result of results) expect(result).toContain("CHECK constraint failed");
  });

  it("refuses a status other than open and resolved", async () => {
    expect(await run(insertRow({ status: "read", actions: ACTIONS, resolution: null }))).toContain(
      "CHECK constraint failed",
    );
  });

  it("refuses text that is not JSON in the producer, the subject, the actions or the resolution", async () => {
    const results = await run(
      Effect.all([
        insertRow({ status: "open", actions: ACTIONS, resolution: null, producer: "core" }),
        insertRow({ status: "open", actions: ACTIONS, resolution: null, subject: "[" }),
        insertRow({ status: "open", actions: "not json", resolution: null }),
        insertRow({ status: "resolved", actions: ACTIONS, resolution: "withdrawn" }),
      ]),
    );

    for (const result of results) expect(result).toContain("CHECK constraint failed");
  });

  it("serves the list from an index, without a temporary b-tree", async () => {
    const plan = await run(
      explainQueryPlan(`SELECT id FROM notifications ORDER BY created_at DESC, id DESC LIMIT 51`),
    );

    expect(plan).toContain("notifications_created");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  // The partial index must hold both columns of the lookup's ORDER BY. With
  // `created_at` alone, SQLite scans every notification through
  // `notifications_created` instead.
  it("serves the lookup of open decisions about a subject from the open-only index", async () => {
    // The query `listOpenAbout` in `notifications/repository.ts` runs.
    const plan = await run(
      explainQueryPlan(`SELECT notifications.id FROM notifications
                        WHERE notifications.status = 'open'
                          AND EXISTS (SELECT 1 FROM json_each(notifications.subject) AS subject
                                      WHERE subject.value ->> 'kind' = 'task'
                                        AND subject.value ->> 'id' = 'x')
                        ORDER BY notifications.created_at, notifications.id`),
    );

    expect(plan).toContain("USING INDEX notifications_open");
    expect(plan).not.toContain("TEMP B-TREE");
  });
});
