/**
 * What the lifecycle migration does to rows that were already there.
 *
 * The repo's other migration tests read `sqlite_master` on a fully migrated
 * database, which says nothing about a rewrite: this one migrates to the schema
 * before it, writes the rows only that schema could hold, and migrates the rest
 * of the way.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** Everything up to and including `plugins`: the schema `state` still existed in. */
const BEFORE = migrations.filter(([id]) => id < 8);

interface Row {
  readonly name: string;
  readonly connectivity: string;
  readonly lifecycle: string;
  readonly reserved: number;
  readonly max_concurrent_sessions: number | null;
}

/**
 * Every column the rewrite copies rather than computes, each with a value
 * nothing else in the fleet has: a `SELECT` that transposed two of them would
 * otherwise corrupt every runner's reported state and pass.
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
 * Ids shaped the way `mintUuid` shapes them: a UUIDv7 spends its first twelve
 * hex digits on a millisecond clock, so every runner of one fleet shares them
 * and only the tail tells two apart. The duplicated pair below is given that
 * shape on purpose, because a rename reading the leading digits would pass a
 * test with unrelated ids and collide in production.
 */
const SHARED_PREFIX = "0199e0e77b21";

const idOf = (tail: string): string => `${SHARED_PREFIX}${tail}`;

/**
 * One row per old `state`, then a duplicated name whose two rows differ only in
 * the random tail of their ids. `online-one` carries the sentinels the rewrite
 * has to bring across untouched.
 */
const SEEDED: ReadonlyArray<{
  readonly name: string;
  readonly state: string;
  readonly id: string;
}> = [
  { name: "online-one", state: "online", id: idOf("70008000000000000001") },
  { name: "offline-one", state: "offline", id: idOf("70008000000000000002") },
  { name: "unreachable-one", state: "unreachable", id: idOf("70008000000000000003") },
  { name: "draining-one", state: "draining", id: idOf("70008000000000000004") },
  { name: "retired-one", state: "retired", id: idOf("70008000000000000005") },
  { name: "iris", state: "online", id: idOf("7000800000000a1b2c3d") },
  { name: "iris", state: "offline", id: idOf("7000800000004e5f6a7b") },
];

/**
 * `created_at` orders the two `iris` rows, so which of them keeps the name is
 * the arrangement's to decide rather than the row order's.
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
  // The index is what holds when a service check is bypassed or wrong, so the
  // refusal is asked of the database rather than of `runner.update`.
  const takenName = yield* Effect.exit(
    sql`UPDATE runners SET name = 'iris' WHERE name = 'online-one'`,
  );
  return { rows, carried: carried[0], indexes: indexes.map((index) => index.name), takenName };
}).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie);

describe("the rows a fleet already had", () => {
  it("splits each old state across the two axes it was answering at once", async () => {
    const { rows } = await Effect.runPromise(migrated);

    expect(rows.map((row) => `${row.connectivity}/${row.lifecycle}`)).toEqual([
      "online/active",
      "offline/active",
      "unreachable/active",
      // The two the old column held as a lifecycle say nothing about
      // reachability, so they arrive as the machine not being connected.
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

  it("carries every column it does not rewrite across untouched", async () => {
    const { carried } = await Effect.runPromise(migrated);

    // The rewrite copies eleven columns it never looks at, so a transposed pair
    // in its SELECT would silently rewrite what every machine reported.
    expect(carried).toEqual(CARRIED);
  });

  it("keeps both runners of a duplicated name, renaming the later one", async () => {
    const { rows } = await Effect.runPromise(migrated);

    // The oldest row of a name keeps it untouched.
    expect(rows.filter((row) => row.name === "iris")).toHaveLength(1);

    // The loser is named from the last eight hex digits of its own id, which
    // are random. The twelve these two ids share are a millisecond clock.
    const renamed = rows.find((row) => row.name.startsWith("runner-"));
    expect(renamed?.name).toBe(`runner-${SEEDED[6]!.id.slice(-8)}`);
    expect(rows).toHaveLength(SEEDED.length);
  });
});

describe("the indexes the rebuilt table carries", () => {
  it("holds a name to one runner, and keeps no index the old table had", async () => {
    const { indexes, takenName } = await Effect.runPromise(migrated);

    expect(indexes).toEqual(["runners_credential_hash", "runners_name"]);
    expect(takenName._tag, "a name another runner holds was accepted").toBe("Failure");
  });
});
