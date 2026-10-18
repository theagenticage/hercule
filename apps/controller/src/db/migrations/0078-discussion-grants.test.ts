/**
 * Tests what the migration that gives the shipped profiles `discussion.read`
 * and `discussion.write` does to profiles that already exist.
 *
 * Seeding cannot do this: it inserts a profile only if it is absent, so an
 * installed profile would keep the grants it was seeded with. The tests cover
 * the states a database can be in:
 *
 * - the shipped profiles without the grants;
 * - a shipped profile that already has one of them;
 * - the migration running a second time;
 * - a profile the user made;
 * - a shipped profile the user renamed, and a custom profile that took its name.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabaseWriter } from "../testing";
import { runMigrations } from "../migrate";
import { migrations } from "./index";
import discussionGrants from "./0078-discussion-grants";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 78);

/**
 * The migrations up to and including the one under test. A later migration
 * may change the same profiles, so the test stops here.
 */
const THROUGH = migrations.filter(([id]) => id <= 78);

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
      if (options.runAgain) yield* discussionGrants;
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
  { name: "assistant", grants: ["task.read", "session.spawn"], shipped: true },
  { name: "worker", grants: ["task.read", "event.read"], shipped: true },
  // Already has one grant: a user added it by hand before upgrading.
  { name: "unrestricted", grants: ["task.read", "discussion.read"], shipped: true },
  { name: "reviewer", grants: ["task.read"], shipped: false },
];

describe("discussion grants on the shipped profiles seeded before they existed", () => {
  it("adds both to assistant and worker, keeps the other grants, and updates updated_at", async () => {
    const profiles = await seedAndMigrate(SHIPPED);

    expect(profiles.get("assistant")?.grants).toEqual([
      "task.read",
      "session.spawn",
      "discussion.read",
      "discussion.write",
    ]);
    expect(profiles.get("worker")?.grants).toEqual([
      "task.read",
      "event.read",
      "discussion.read",
      "discussion.write",
    ]);
    // The rows changed, so their updated_at is no longer the first-run time.
    expect(profiles.get("assistant")?.updatedAt).not.toBe(at);
    expect(profiles.get("worker")?.updatedAt).not.toBe(at);
  });

  it("adds only the missing grant to a profile that already has one", async () => {
    const profiles = await seedAndMigrate(SHIPPED);

    expect(profiles.get("unrestricted")?.grants).toEqual([
      "task.read",
      "discussion.read",
      "discussion.write",
    ]);
  });

  it("adds nothing when the migration runs a second time", async () => {
    const profiles = await seedAndMigrate(SHIPPED, { runAgain: true });

    expect(profiles.get("worker")?.grants).toEqual([
      "task.read",
      "event.read",
      "discussion.read",
      "discussion.write",
    ]);
  });

  it("leaves a profile the user made unchanged", async () => {
    const profiles = await seedAndMigrate(SHIPPED);

    expect(profiles.get("reviewer")).toEqual({ grants: ["task.read"], updatedAt: at });
  });

  it("gives the grants to a renamed shipped profile, and not to a custom profile with its old name", async () => {
    // Names are unique, so a user who wants their own `worker` has renamed
    // the shipped one first. The renamed one is still the shipped worker,
    // and the one the user wrote must not be widened.
    const profiles = await seedAndMigrate([
      { name: "helper", grants: ["task.read"], shipped: true },
      { name: "worker", grants: ["task.read"], shipped: false },
    ]);

    expect(profiles.get("worker")).toEqual({ grants: ["task.read"], updatedAt: at });
    expect(profiles.get("helper")?.grants).toEqual([
      "task.read",
      "discussion.read",
      "discussion.write",
    ]);
  });
});
