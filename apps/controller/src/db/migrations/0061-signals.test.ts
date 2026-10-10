/**
 * Tests the rules the signals migration puts in the tables themselves, on a
 * migrated in-memory database:
 *
 * - an open signal has no resolution, and a resolved one has one;
 * - the JSON columns hold valid JSON;
 * - deleting a signal deletes its event links;
 * - the to-do view and the lookup by event each read an index without
 *   sorting.
 *
 * The rows are written in plain SQL, so the tables' checks are tested on their
 * own rather than behind the service that already follows them.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "../testing";

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestDatabase));

const at = "2026-10-01T00:00:00.000Z";

const ORIGIN = JSON.stringify({
  type: "api",
  actor: "user",
  eventIds: [7],
  reason: "a reason",
});
const RESOLUTION = JSON.stringify({
  kind: "withdrawn",
  outcome: "no longer needed",
  actor: "user",
  origin: "web",
  at,
});

/** The columns a test sets; every other column gets a valid value. */
interface Row {
  readonly id?: string;
  readonly status: string;
  readonly resolution: string | null;
  readonly origin?: string;
  readonly blocks?: string;
}

/**
 * Inserts one signal row and returns `accepted`, or the database's error
 * message when a constraint refuses the row.
 */
const insertRow = (row: Row) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* Effect.match(
      sql`
        INSERT INTO signals
          (id, kind, origin, title, priority, blocks, actions, match, status, resolution, created_at)
        VALUES
          (${row.id === undefined ? sql.literal("randomblob(16)") : sql.literal(`x'${row.id}'`)},
           'fyi', ${row.origin ?? ORIGIN}, 'a title', 'normal', ${row.blocks ?? "[]"}, '[]', '{}',
           ${row.status}, ${row.resolution}, ${at})`,
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

describe("the signals table", () => {
  it("accepts an open signal without a resolution and a resolved one with a resolution", async () => {
    const results = await run(
      Effect.all([
        insertRow({ status: "open", resolution: null }),
        insertRow({ status: "resolved", resolution: RESOLUTION }),
      ]),
    );

    expect(results).toEqual(["accepted", "accepted"]);
  });

  it("refuses an open signal with a resolution and a resolved one without", async () => {
    const results = await run(
      Effect.all([
        insertRow({ status: "open", resolution: RESOLUTION }),
        insertRow({ status: "resolved", resolution: null }),
      ]),
    );

    for (const result of results) expect(result).toContain("CHECK constraint failed");
  });

  it("refuses text that is not JSON in the origin, the blocks or the resolution", async () => {
    const results = await run(
      Effect.all([
        insertRow({ status: "open", resolution: null, origin: "api" }),
        insertRow({ status: "open", resolution: null, blocks: "[" }),
        insertRow({ status: "resolved", resolution: "withdrawn" }),
      ]),
    );

    for (const result of results) expect(result).toContain("CHECK constraint failed");
  });

  it("deletes a signal's event links with the signal", async () => {
    const id = "0199e0e77b2170008000000000000001";
    const remaining = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertRow({ id, status: "open", resolution: null });
        yield* sql`INSERT INTO signal_events (signal_id, event_id) VALUES (${sql.literal(`x'${id}'`)}, 7)`;
        yield* sql`DELETE FROM signals`;
        return yield* sql<{ readonly count: number }>`SELECT count(*) AS count FROM signal_events`;
      }),
    );

    expect(remaining).toEqual([{ count: 0 }]);
  });

  it("serves the to-do view from the open-only index, oldest first, without sorting", async () => {
    const plan = await run(
      explainQueryPlan(`SELECT id FROM signals WHERE status = 'open' ORDER BY created_at, id`),
    );

    expect(plan).toContain("USING INDEX signals_open");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("finds the signals that name an event from an index", async () => {
    const plan = await run(
      explainQueryPlan(`SELECT signal_id FROM signal_events WHERE event_id = 7`),
    );

    expect(plan).toContain("signal_events_event");
  });
});
