/**
 * Tests what the drop signal snoozes migration does to a database at the
 * previous head: the snoozes table is gone, and a signal that was snoozed is
 * an open signal like any other, with its lowered priority kept.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TestDatabaseWriter } from "../testing";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 132);

const at = "2026-11-01T00:00:00.000Z";

describe("the drop signal snoozes migration", () => {
  it("drops the snoozes and leaves the snoozed signal open, lowered as it was", async () => {
    const { tables, signals } = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`
          INSERT INTO signals
            (id, kind, origin, title, priority, blocks, actions, match, status, created_at,
             priority_lowered)
          VALUES (x'01', 'fyi', '{}', 'Snoozed', 'high', '[]', '[]', '{}', 'open', ${at}, 1)`;
        yield* sql`
          INSERT INTO signal_snoozes (signal_id, until, snoozed_at, actor)
          VALUES (x'01', '2999-01-01T00:00:00.000Z', ${at}, 'user')`;
        yield* runMigrations();
        const tables = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE name LIKE 'signal_snoozes%'`;
        const signals = yield* sql<{
          readonly title: string;
          readonly status: string;
          readonly priority: string;
          readonly priority_lowered: number;
        }>`SELECT title, status, priority, priority_lowered FROM signals`;
        return { tables, signals };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(tables).toEqual([]);
    expect(signals).toEqual([
      { title: "Snoozed", status: "open", priority: "high", priority_lowered: 1 },
    ]);
  });
});
