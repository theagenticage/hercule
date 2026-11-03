/**
 * Tests what the disk usage migration does to a database at the previous
 * head: rows that exist keep every old value and read no disk usage, and the
 * checks refuse a row that holds only some of the columns written together.
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

const BEFORE = migrations.filter(([id]) => id < 108);
const UP_TO_DISK_USAGE = migrations.filter(([id]) => id <= 108);

const NOW = "2026-11-01T00:00:00.000Z";

const RUNNER = "unhex('0199e0e77b2170008000000000000001')";
const WORKSPACE = "unhex('0199e0e77b21700080000000000000a1')";

/** Writes a runner and a workspace on it, as the previous head stores them. */
const insertRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash, created_at, updated_at)
             VALUES (${sql.literal(RUNNER)}, 'one', 'online', 'active', 0, '[]', 'hash-1', ${NOW}, ${NOW})`;
  yield* sql`INSERT INTO workspaces (id, runner_id, kind, status, created_at, ownership, warnings)
             VALUES (${sql.literal(WORKSPACE)}, ${sql.literal(RUNNER)}, 'ephemeral', 'ready', ${NOW}, 'managed', '[]')`;
});

describe("the disk usage migration", () => {
  it("leaves existing workspaces and runners with no disk usage", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertRows;
        yield* runMigrations(UP_TO_DISK_USAGE);
        const workspaces = yield* sql`
          SELECT status, size_bytes, frees_bytes, disk_usage_measured_at, disk_usage_error
          FROM workspaces`;
        const runners = yield* sql`
          SELECT name, repository_cache_bytes, harness_home_bytes, disk_usage_measured_at
          FROM runners`;
        return { workspaces, runners };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(result.workspaces).toEqual([
      {
        status: "ready",
        size_bytes: null,
        frees_bytes: null,
        disk_usage_measured_at: null,
        disk_usage_error: null,
      },
    ]);
    expect(result.runners).toEqual([
      {
        name: "one",
        repository_cache_bytes: null,
        harness_home_bytes: null,
        disk_usage_measured_at: null,
      },
    ]);
  });

  it("accepts a failure with no numbers, and refuses numbers written in part", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_DISK_USAGE);
        yield* insertRows;
        const failureOnly = yield* Effect.exit(
          sql`UPDATE workspaces SET disk_usage_error = 'too slow'`,
        );
        const whole = yield* Effect.exit(
          sql`UPDATE workspaces SET size_bytes = 5, frees_bytes = 3, disk_usage_measured_at = ${NOW}`,
        );
        const partialWorkspace = yield* Effect.exit(
          sql`UPDATE workspaces SET size_bytes = NULL, frees_bytes = 3`,
        );
        const partialRunner = yield* Effect.exit(
          sql`UPDATE runners SET repository_cache_bytes = 5`,
        );
        const wholeRunner = yield* Effect.exit(
          sql`UPDATE runners SET repository_cache_bytes = 5, harness_home_bytes = 6, disk_usage_measured_at = ${NOW}`,
        );
        return [failureOnly, whole, partialWorkspace, partialRunner, wholeRunner].map(
          Exit.isFailure,
        );
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(result).toEqual([false, false, true, true, false]);
  });
});
