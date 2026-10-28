/**
 * Tests the tables and indexes the signal snoozes migration adds, on a
 * migrated temporary database:
 *
 * - deleting a signal deletes its snooze;
 * - a signal is not lowered until it is marked so;
 * - the Later view reads the snoozes by `until` from an index without sorting;
 * - the Done view reads the resolved signals, newest resolution first, from an
 *   index without sorting, and seeks a page from it;
 * - the Done view filtered to one kind reads the kind index without sorting;
 *   filtered to one source (a range of kinds) it reads the same index but
 *   sorts, because the resolutions of several kinds interleave.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { inTransaction, TestDatabase } from "../testing";

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestDatabase));

const ID = "0199e0e77b2170008000000000000001";
const at = "2026-10-01T00:00:00.000Z";

/** Returns SQLite's plan for a statement, its steps joined with " / ". */
const explainQueryPlan = (statement: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly detail: string }>`${sql.literal(`EXPLAIN QUERY PLAN ${statement}`)}`,
      (rows) => rows.map((row) => row.detail).join(" / "),
    ),
  );

/** Inserts one resolved signal row with the given id. */
const insertResolvedSignal = (id: string) =>
  inTransaction(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`
        INSERT INTO signals
          (id, kind, origin, title, priority, blocks, actions, match, status, resolution, created_at)
        VALUES
          (${sql.literal(`x'${id}'`)}, 'fyi', '{}', 'a title', 'normal', '[]', '[]', '{}',
           'resolved', ${JSON.stringify({ kind: "withdrawn", at })}, ${at})`,
    ),
  );

describe("the signal snoozes migration", () => {
  it("deletes a signal's snooze with the signal, and leaves a signal unlowered", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* inTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO signals
                (id, kind, origin, title, priority, blocks, actions, match, status, created_at)
              VALUES
                (${sql.literal(`x'${ID}'`)}, 'fyi', '{}', 'a title', 'normal', '[]', '[]', '{}',
                 'open', ${at})`;
            yield* sql`
              INSERT INTO signal_snoozes (signal_id, until, snoozed_at, actor)
              VALUES (${sql.literal(`x'${ID}'`)}, ${at}, ${at}, 'user')`;
          }),
        );
        const lowered = yield* sql<{ readonly priority_lowered: number }>`
          SELECT priority_lowered FROM signals`;
        yield* inTransaction(sql`DELETE FROM signals`);
        const snoozes = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM signal_snoozes`;
        return { lowered, snoozes };
      }),
    );

    expect(result).toEqual({ lowered: [{ priority_lowered: 0 }], snoozes: [{ count: 0 }] });
  });

  it("reads the resolution's time into the resolved_at column", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertResolvedSignal(ID);
        return yield* sql<{ readonly resolved_at: string }>`SELECT resolved_at FROM signals`;
      }),
    );

    expect(rows).toEqual([{ resolved_at: at }]);
  });

  it("serves the Later view from the until index without sorting", async () => {
    const plan = await run(
      explainQueryPlan(
        `SELECT s.id FROM signal_snoozes z JOIN signals s ON s.id = z.signal_id
         WHERE z.until > '${at}'
           AND (z.until > '${at}' OR (z.until = '${at}' AND z.signal_id > x'${ID}'))
         ORDER BY z.until, z.signal_id`,
      ),
    );

    expect(plan).toMatch(/USING (COVERING )?INDEX signal_snoozes_until\b/);
    expect(plan).not.toContain("TEMP B-TREE");
  });

  // The seek is written the way the keyset helper in db/page.ts writes it.
  it("serves a page of the Done view from the resolved index without sorting", async () => {
    const plan = await run(
      explainQueryPlan(
        `SELECT id FROM signals WHERE status = 'resolved'
           AND (resolved_at < '${at}' OR (resolved_at = '${at}' AND id < x'${ID}'))
         ORDER BY resolved_at DESC, id DESC`,
      ),
    );

    expect(plan).toMatch(/USING (COVERING )?INDEX signals_resolved\b/);
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("serves a page of the Done view for one kind from the kind index without sorting", async () => {
    const plan = await run(
      explainQueryPlan(
        `SELECT id FROM signals WHERE status = 'resolved' AND kind = 'github/pr'
           AND (resolved_at < '${at}' OR (resolved_at = '${at}' AND id < x'${ID}'))
         ORDER BY resolved_at DESC, id DESC`,
      ),
    );

    expect(plan).toMatch(/USING (COVERING )?INDEX signals_resolved_kind \(kind=\?/);
    expect(plan).not.toContain("TEMP B-TREE");
  });

  // A source is a range of kinds. The index narrows the rows to that range,
  // but the rows of several kinds are not in resolution order, so SQLite sorts
  // the range. It sorts only the source's resolved signals, not all of them.
  it("narrows the Done view for one source to its kinds through the kind index", async () => {
    const plan = await run(
      explainQueryPlan(
        `SELECT id FROM signals WHERE status = 'resolved'
           AND kind >= 'github/' AND kind < 'github0'
         ORDER BY resolved_at DESC, id DESC`,
      ),
    );

    expect(plan).toMatch(/USING (COVERING )?INDEX signals_resolved_kind \(kind>\? AND kind<\?\)/);
  });
});
