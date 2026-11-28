/**
 * Tests what the migration that gives the shipped `unrestricted`, `worker`
 * and `assistant` profiles their `mcp` grants does to profiles that already
 * exist.
 *
 * Seeding cannot do this: it inserts a profile only if it is absent, so an
 * installed profile would keep the grants it was seeded with. The tests cover
 * the states a database can be in:
 *
 * - the three shipped profiles without the grants;
 * - the migration running a second time;
 * - `mcp.manage`, which no profile may gain;
 * - a profile the user made;
 * - a custom profile the user gave the name of a shipped one.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TestDatabaseWriter } from "../testing";
import { runMigrations } from "../migrate";
import { migrations } from "./index";
import mcpGrants from "./0126-mcp-grants";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 126);

/**
 * The migrations up to and including the one under test. A later migration
 * may change the same profiles, so the test stops here.
 */
const THROUGH = migrations.filter(([id]) => id <= 126);

const at = "2026-10-01T00:00:00.000Z";

interface Seeded {
  readonly name: string;
  readonly grants: ReadonlyArray<string>;
  readonly shipped: boolean;
}

interface Read {
  readonly grants: ReadonlyArray<string>;
  readonly updatedAt: string;
}

/**
 * Returns the profiles after the migration has run. With `runAgain`, it runs
 * the migration a second time on the migrated database first.
 */
const seedAndMigrate = (
  seeded: ReadonlyArray<Seeded>,
  options: { readonly runAgain: boolean } = { runAgain: false },
): Promise<ReadonlyMap<string, Read>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(BEFORE);
      yield* Effect.forEach(
        seeded,
        (profile, index) =>
          sql`INSERT INTO permission_profiles (id, name, grants, shipped, created_at, updated_at)
            VALUES (unhex(${`0199e0e77b217000800000000000${String(index).padStart(4, "0")}`}),
                    ${profile.name}, ${JSON.stringify(profile.grants)},
                    ${profile.shipped ? 1 : 0}, ${at}, ${at})`,
      );
      yield* runMigrations(THROUGH);
      if (options.runAgain) yield* mcpGrants;
      const rows = yield* sql<{
        readonly name: string;
        readonly grants: string;
        readonly updated_at: string;
      }>`SELECT name, grants, updated_at FROM permission_profiles ORDER BY name`;
      return new Map(
        rows.map((row) => [
          row.name,
          { grants: JSON.parse(row.grants) as ReadonlyArray<string>, updatedAt: row.updated_at },
        ]),
      );
    }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
  );

/** The profiles an older build seeded, written the way that build wrote them. */
const SHIPPED: ReadonlyArray<Seeded> = [
  { name: "assistant", grants: ["task.read", "skill.read"], shipped: true },
  { name: "worker", grants: ["task.read", "event.read"], shipped: true },
  { name: "unrestricted", grants: ["task.read", "permission.write"], shipped: true },
  { name: "reviewer", grants: ["task.read"], shipped: false },
];

describe("the mcp grants on shipped profiles seeded before they existed", () => {
  it.each([
    ["unrestricted", ["task.read", "permission.write", "mcp.read", "mcp.use"]],
    ["worker", ["task.read", "event.read", "mcp.read", "mcp.use"]],
    // The assistant may read the servers but not use their tools.
    ["assistant", ["task.read", "skill.read", "mcp.read"]],
  ])(
    "gives the shipped %s profile its mcp grants, keeps its other grants, and updates updated_at",
    async (name, grants) => {
      const profiles = await seedAndMigrate(SHIPPED);

      expect(profiles.get(name)?.grants).toEqual(grants);
      // The row changed, so its updated_at is no longer the first-run time.
      expect(profiles.get(name)?.updatedAt).not.toBe(at);
    },
  );

  it("gives no profile mcp.manage", async () => {
    const profiles = await seedAndMigrate(SHIPPED);

    for (const read of profiles.values()) expect(read.grants).not.toContain("mcp.manage");
  });

  it("adds nothing when the migration runs a second time", async () => {
    const profiles = await seedAndMigrate(SHIPPED, { runAgain: true });

    expect(profiles.get("unrestricted")?.grants).toEqual([
      "task.read",
      "permission.write",
      "mcp.read",
      "mcp.use",
    ]);
    expect(profiles.get("worker")?.grants).toEqual([
      "task.read",
      "event.read",
      "mcp.read",
      "mcp.use",
    ]);
    expect(profiles.get("assistant")?.grants).toEqual(["task.read", "skill.read", "mcp.read"]);
  });

  it("adds only the missing grant to a profile that already has one", async () => {
    const profiles = await seedAndMigrate([{ name: "worker", grants: ["mcp.use"], shipped: true }]);

    expect(profiles.get("worker")?.grants).toEqual(["mcp.use", "mcp.read"]);
  });

  it("leaves a profile the user made unchanged", async () => {
    const profiles = await seedAndMigrate(SHIPPED);

    expect(profiles.get("reviewer")).toEqual({ grants: ["task.read"], updatedAt: at });
  });

  it("leaves custom profiles named like shipped ones unchanged", async () => {
    // Names are unique, so a user who wants their own `worker` has renamed
    // the shipped one first. The renamed profile is still shipped but no
    // longer matched by name, and the custom one must not be widened.
    const profiles = await seedAndMigrate([
      { name: "everything", grants: ["task.read"], shipped: true },
      { name: "unrestricted", grants: ["task.read"], shipped: false },
      { name: "helper", grants: ["task.read"], shipped: true },
      { name: "worker", grants: ["task.read"], shipped: false },
      { name: "assistant", grants: ["task.read"], shipped: false },
    ]);

    for (const name of ["everything", "unrestricted", "helper", "worker", "assistant"]) {
      expect(profiles.get(name)).toEqual({ grants: ["task.read"], updatedAt: at });
    }
  });
});
