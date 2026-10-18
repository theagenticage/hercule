/**
 * Tests what the migration that gives the shipped `unrestricted` and
 * `assistant` profiles their `skill` grants does to profiles that already
 * exist.
 *
 * Seeding cannot do this: it inserts a profile only if it is absent, so an
 * installed profile would keep the grants it was seeded with. The tests cover
 * the states a database can be in:
 *
 * - `unrestricted` and `assistant` without the grants;
 * - the migration running a second time;
 * - `worker`, which must stay without any `skill` grant;
 * - a profile the user made;
 * - a custom profile the user gave the name `unrestricted` or `assistant`.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";
import skillGrants from "./0085-skill-grants";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 85);

/**
 * The migrations up to and including the one under test. A later migration
 * may change the same profiles, so the test stops here.
 */
const THROUGH = migrations.filter(([id]) => id <= 85);

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
      if (options.runAgain) yield* skillGrants;
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
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

/** The profiles an older build seeded, written the way that build wrote them. */
const SHIPPED: ReadonlyArray<Seeded> = [
  { name: "assistant", grants: ["task.read", "wiki.read"], shipped: true },
  { name: "worker", grants: ["task.read", "event.read"], shipped: true },
  { name: "unrestricted", grants: ["task.read", "permission.write"], shipped: true },
  { name: "reviewer", grants: ["task.read"], shipped: false },
];

describe("the skill grants on shipped profiles seeded before they existed", () => {
  it("adds skill.read to unrestricted, keeps its other grants, and updates updated_at", async () => {
    const profiles = await seedAndMigrate(SHIPPED);

    expect(profiles.get("unrestricted")?.grants).toEqual([
      "task.read",
      "permission.write",
      "skill.read",
    ]);
    // The row changed, so its updated_at is no longer the first-run time.
    expect(profiles.get("unrestricted")?.updatedAt).not.toBe(at);
  });

  it("adds skill.read and skill.write to assistant, but not skill.apply", async () => {
    const profiles = await seedAndMigrate(SHIPPED);

    expect(profiles.get("assistant")?.grants).toEqual([
      "task.read",
      "wiki.read",
      "skill.read",
      "skill.write",
    ]);
    expect(profiles.get("assistant")?.updatedAt).not.toBe(at);
  });

  it("adds nothing when the migration runs a second time", async () => {
    const profiles = await seedAndMigrate(SHIPPED, { runAgain: true });

    expect(profiles.get("unrestricted")?.grants).toEqual([
      "task.read",
      "permission.write",
      "skill.read",
    ]);
    expect(profiles.get("assistant")?.grants).toEqual([
      "task.read",
      "wiki.read",
      "skill.read",
      "skill.write",
    ]);
  });

  it("adds only the missing grant to a profile that already has one", async () => {
    const profiles = await seedAndMigrate([
      { name: "assistant", grants: ["skill.read"], shipped: true },
    ]);

    expect(profiles.get("assistant")?.grants).toEqual(["skill.read", "skill.write"]);
  });

  it("leaves worker without any skill grant", async () => {
    const profiles = await seedAndMigrate(SHIPPED);

    expect(profiles.get("worker")).toEqual({ grants: ["task.read", "event.read"], updatedAt: at });
  });

  it("leaves a profile the user made unchanged", async () => {
    const profiles = await seedAndMigrate(SHIPPED);

    expect(profiles.get("reviewer")).toEqual({ grants: ["task.read"], updatedAt: at });
  });

  it("leaves custom profiles named unrestricted and assistant unchanged", async () => {
    // Names are unique, so a user who wants their own `unrestricted` has
    // renamed the shipped one first. The renamed profile is still shipped but
    // no longer matched by name, and the custom one must not be widened.
    const profiles = await seedAndMigrate([
      { name: "everything", grants: ["task.read"], shipped: true },
      { name: "unrestricted", grants: ["task.read"], shipped: false },
      { name: "helper", grants: ["task.read"], shipped: true },
      { name: "assistant", grants: ["task.read"], shipped: false },
    ]);

    for (const name of ["everything", "unrestricted", "helper", "assistant"]) {
      expect(profiles.get(name)).toEqual({ grants: ["task.read"], updatedAt: at });
    }
  });
});
