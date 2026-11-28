/**
 * Tests what the runner metrics migration does to a database at the previous
 * head: the report in a runner's `watermark` column is readable, unchanged, in
 * the `metrics` column, and the disk limit keeps its own column.
 *
 * The tests stop at this migration, so a later migration cannot change what
 * they check.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 103);
const UP_TO_RUNNER_METRICS = migrations.filter(([id]) => id <= 103);

const NOW = "2026-11-01T00:00:00.000Z";

const REPORT = '{"diskFreeBytes":42949672960,"availableMemoryBytes":8589934592}';

describe("the runner metrics migration", () => {
  it("keeps a runner's report, and the disk limit beside it", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`INSERT INTO runners
                     (id, name, connectivity, lifecycle, reserved, labels, credential_hash,
                      watermark, disk_watermark_bytes, created_at, updated_at)
                   VALUES (unhex('0199e0e77b2170008000000000000001'), 'reported', 'online', 'active', 0,
                           '[]', 'hash-1', ${REPORT}, 2147483648, ${NOW}, ${NOW}),
                          (unhex('0199e0e77b2170008000000000000002'), 'silent', 'offline', 'active', 0,
                           '[]', 'hash-2', NULL, NULL, ${NOW}, ${NOW})`;
        yield* runMigrations(UP_TO_RUNNER_METRICS);
        return yield* sql<{
          readonly name: string;
          readonly metrics: string | null;
          readonly disk_watermark_bytes: number | null;
        }>`SELECT name, metrics, disk_watermark_bytes FROM runners ORDER BY name`;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(result).toEqual([
      { name: "reported", metrics: REPORT, disk_watermark_bytes: 2147483648 },
      { name: "silent", metrics: null, disk_watermark_bytes: null },
    ]);
  });
});
