/**
 * Tests what the runner metrics history migration does to a database at the
 * previous head: the new table keeps one row per runner per minute, goes with
 * its runner, and has no index but its key.
 *
 * The tests stop at this migration, so a later migration cannot change what
 * they check.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const UP_TO_HISTORY = migrations.filter(([id]) => id <= 105);

const NOW = "2026-11-01T00:00:00.000Z";

const RUNNER = "unhex('0199e0e77b2170008000000000000001')";

describe("the runner metrics history migration", () => {
  it("keeps one row per runner per minute, and removes a runner's rows with the runner", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_HISTORY);
        yield* sql`INSERT INTO runners
                     (id, name, connectivity, lifecycle, reserved, labels, credential_hash,
                      created_at, updated_at)
                   VALUES (${sql.literal(RUNNER)}, 'one', 'online', 'active', 0, '[]', 'hash-1',
                           ${NOW}, ${NOW})`;
        const insert = sql`INSERT INTO runner_metrics
                             (runner_id, minute, disk_free_bytes, available_memory_bytes,
                              cpu_average_percent, cpu_peak_percent, sessions_running,
                              sessions_queued)
                           VALUES (${sql.literal(RUNNER)}, 60000, 1, 2, NULL, NULL, 0, 0)`;
        yield* insert;
        const again = yield* Effect.exit(insert);
        const before = yield* sql`SELECT minute FROM runner_metrics`;
        yield* sql`DELETE FROM runners`;
        const after = yield* sql`SELECT minute FROM runner_metrics`;
        const indexes = yield* sql<{
          readonly name: string;
        }>`SELECT name FROM pragma_index_list('runner_metrics')`;
        return { repeated: Exit.isFailure(again), before, after, indexes };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(result.repeated).toBe(true);
    expect(result.before).toEqual([{ minute: 60000 }]);
    expect(result.after).toEqual([]);
    // The primary key is the only index; the table has no other.
    expect(result.indexes).toHaveLength(1);
  });
});
