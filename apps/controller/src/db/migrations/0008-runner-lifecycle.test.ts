/**
 * Tests what the lifecycle migration does to rows that already exist.
 *
 * The other migration tests read `sqlite_master` on a fully migrated database,
 * which cannot test how existing rows are rewritten. This test migrates to the
 * schema before this migration, writes rows only that schema allows, and then
 * runs the remaining migrations.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations up to and including `plugins`: the last schema that still had `state`. */
const BEFORE = migrations.filter(([id]) => id < 8);

interface Row {
  readonly name: string;
  readonly connectivity: string;
  readonly lifecycle: string;
  readonly reserved: number;
  readonly max_concurrent_sessions: number | null;
}

/**
 * Every column the migration copies rather than computes, each with a value no
 * other runner has. Otherwise a `SELECT` that swapped two of them would corrupt
 * every runner's reported state and still pass.
 */
const CARRIED = {
  labels: '["gpu","primary"]',
  binary_version: "0.4.2",
  protocol_version: 1,
  negotiated_capabilities: '["sessions"]',
  facts: '{"os":"darwin"}',
  watermark: '{"diskFreeBytes":42}',
  last_seen_at: "2026-09-05T09:14:00.000Z",
  credential_hash: "hash-0",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-06T00:00:00.000Z",
} as const;

/**
 * Ids in the same format `mintUuid` creates: a UUIDv7 uses its first twelve
 * hex digits for a millisecond clock, so runners created close together share
 * them and only the last digits tell two apart. The duplicated pair below has
 * that format on purpose: a rename that used the leading digits would pass a
 * test with unrelated ids and collide in production.
 */
const SHARED_PREFIX = "0199e0e77b21";

const buildId = (tail: string): string => `${SHARED_PREFIX}${tail}`;

/**
 * One row per old `state`, then a duplicated name whose two rows differ only in
 * the random end of their ids. `online-one` has the marker values the
 * migration must copy unchanged.
 */
const SEEDED: ReadonlyArray<{
  readonly name: string;
  readonly state: string;
  readonly id: string;
}> = [
  { name: "online-one", state: "online", id: buildId("70008000000000000001") },
  { name: "offline-one", state: "offline", id: buildId("70008000000000000002") },
  { name: "unreachable-one", state: "unreachable", id: buildId("70008000000000000003") },
  { name: "draining-one", state: "draining", id: buildId("70008000000000000004") },
  { name: "retired-one", state: "retired", id: buildId("70008000000000000005") },
  { name: "iris", state: "online", id: buildId("7000800000000a1b2c3d") },
  { name: "iris", state: "offline", id: buildId("7000800000004e5f6a7b") },
];

/**
 * `created_at` orders the two `iris` rows, so the test setup decides which of
 * them keeps the name, not the order the rows were inserted in.
 */
const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations(BEFORE);
  yield* Effect.forEach(
    SEEDED,
    (seed, index) =>
      sql`INSERT INTO runners
          (id, name, state, labels, max_concurrent_sessions, credential_hash,
           binary_version, protocol_version, negotiated_capabilities, facts,
           watermark, last_seen_at, created_at, updated_at)
        VALUES
          (unhex(${seed.id}), ${seed.name}, ${seed.state},
           ${index === 0 ? CARRIED.labels : "[]"},
           ${seed.name === "draining-one" ? 6 : 1}, ${`hash-${String(index)}`},
           ${index === 0 ? CARRIED.binary_version : null},
           ${index === 0 ? CARRIED.protocol_version : null},
           ${index === 0 ? CARRIED.negotiated_capabilities : null},
           ${index === 0 ? CARRIED.facts : null},
           ${index === 0 ? CARRIED.watermark : null},
           ${index === 0 ? CARRIED.last_seen_at : null},
           ${`2026-09-0${String(index + 1)}T00:00:00.000Z`},
           ${CARRIED.updated_at})`,
  );
  yield* runMigrations();
  const rows = yield* sql<Row>`
    SELECT name, connectivity, lifecycle, reserved, max_concurrent_sessions
    FROM runners ORDER BY created_at
  `;
  const carried = yield* sql<typeof CARRIED>`
    SELECT labels, binary_version, protocol_version, negotiated_capabilities, facts,
           watermark, last_seen_at, credential_hash, created_at, updated_at
    FROM runners WHERE name = 'online-one'
  `;
  const indexes = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'runners' AND sql IS NOT NULL
    ORDER BY name
  `;
  // The index still applies when a service check is bypassed or wrong, so the
  // test writes to the database directly rather than through `runner.update`.
  const takenName = yield* Effect.exit(
    sql`UPDATE runners SET name = 'iris' WHERE name = 'online-one'`,
  );
  return { rows, carried: carried[0], indexes: indexes.map((index) => index.name), takenName };
}).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie);

describe("the rows a fleet already had", () => {
  it("splits each old state into connectivity and lifecycle", async () => {
    const { rows } = await Effect.runPromise(migrated);

    expect(rows.map((row) => `${row.connectivity}/${row.lifecycle}`)).toEqual([
      "online/active",
      "offline/active",
      "unreachable/active",
      // The two old values that describe the lifecycle tell us nothing about
      // connectivity, so those runners become offline.
      "offline/draining",
      "offline/retired",
      "online/active",
      "offline/active",
    ]);
  });

  it("reserves nothing and leaves every cap to be derived again", async () => {
    const { rows } = await Effect.runPromise(migrated);

    expect(rows.map((row) => row.reserved)).toEqual(SEEDED.map(() => 0));
    expect(rows.map((row) => row.max_concurrent_sessions)).toEqual(SEEDED.map(() => null));
  });

  it("copies every column it does not rewrite unchanged", async () => {
    const { carried } = await Effect.runPromise(migrated);

    // The migration copies eleven columns it never looks at, so two swapped
    // columns in its SELECT would silently corrupt what every machine reported.
    expect(carried).toEqual(CARRIED);
  });

  it("keeps both runners of a duplicated name, renaming the later one", async () => {
    const { rows } = await Effect.runPromise(migrated);

    // The oldest row with a name keeps it unchanged.
    expect(rows.filter((row) => row.name === "iris")).toHaveLength(1);

    // The later row is renamed using the last eight hex digits of its own id,
    // which are random. The twelve digits these two ids share are a
    // millisecond clock.
    const renamed = rows.find((row) => row.name.startsWith("runner-"));
    expect(renamed?.name).toBe(`runner-${SEEDED[6]!.id.slice(-8)}`);
    expect(rows).toHaveLength(SEEDED.length);
  });
});

describe("the indexes on the rebuilt table", () => {
  it("allows each name on only one runner, and keeps no index from the old table", async () => {
    const { indexes, takenName } = await Effect.runPromise(migrated);

    expect(indexes).toEqual(["runners_credential_hash", "runners_name"]);
    expect(takenName._tag, "a name another runner holds was accepted").toBe("Failure");
  });
});
