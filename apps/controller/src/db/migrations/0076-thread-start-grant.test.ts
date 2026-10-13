/**
 * Tests what the migration that gives the shipped `unrestricted` profile
 * `thread.start` does to profiles that already exist.
 *
 * Seeding cannot do this: it inserts a profile only if it is absent, so an
 * installed profile would keep the grants it was seeded with. The tests cover
 * the states a database can be in:
 *
 * - `unrestricted` without the grant;
 * - the migration running a second time;
 * - `assistant` and `worker`, which must stay without it;
 * - a profile the user made;
 * - a custom profile the user gave the name `unrestricted`.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";
import threadStartGrant from "./0076-thread-start-grant";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 76);

/**
 * The migrations up to and including the one under test. A later migration
 * may change the same profiles, so the test stops here.
 */
const THROUGH = migrations.filter(([id]) => id <= 76);

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
      if (options.runAgain) yield* threadStartGrant;
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
  { name: "assistant", grants: ["task.read", "session.spawn"], shipped: true },
  { name: "worker", grants: ["task.read", "event.read"], shipped: true },
  { name: "unrestricted", grants: ["task.read", "session.spawn"], shipped: true },
  { name: "reviewer", grants: ["task.read", "session.spawn"], shipped: false },
];

describe("thread.start on the shipped unrestricted profile seeded before it existed", () => {
  it("adds the grant to unrestricted, keeps its other grants, and updates updated_at", async () => {
    const profiles = await seedAndMigrate(SHIPPED);

    expect(profiles.get("unrestricted")?.grants).toEqual([
      "task.read",
      "session.spawn",
      "thread.start",
    ]);
    // The row changed, so its updated_at is no longer the first-run time.
    expect(profiles.get("unrestricted")?.updatedAt).not.toBe(at);
  });

  it("adds nothing when the migration runs a second time", async () => {
    const profiles = await seedAndMigrate(SHIPPED, { runAgain: true });

    expect(profiles.get("unrestricted")?.grants).toEqual([
      "task.read",
      "session.spawn",
      "thread.start",
    ]);
  });

  it("leaves assistant and worker without the grant", async () => {
    const profiles = await seedAndMigrate(SHIPPED);

    expect(profiles.get("assistant")).toEqual({
      grants: ["task.read", "session.spawn"],
      updatedAt: at,
    });
    expect(profiles.get("worker")).toEqual({ grants: ["task.read", "event.read"], updatedAt: at });
  });

  it("leaves a profile the user made unchanged", async () => {
    const profiles = await seedAndMigrate(SHIPPED);

    expect(profiles.get("reviewer")).toEqual({
      grants: ["task.read", "session.spawn"],
      updatedAt: at,
    });
  });

  it("leaves a custom profile named unrestricted unchanged when the shipped one was renamed", async () => {
    // Names are unique, so a user who wants their own `unrestricted` has
    // renamed the shipped one first. The renamed profile is still shipped but
    // no longer matched by name, and the custom one must not be widened.
    const profiles = await seedAndMigrate([
      { name: "everything", grants: ["task.read"], shipped: true },
      { name: "unrestricted", grants: ["task.read"], shipped: false },
    ]);

    expect(profiles.get("unrestricted")).toEqual({ grants: ["task.read"], updatedAt: at });
    expect(profiles.get("everything")).toEqual({ grants: ["task.read"], updatedAt: at });
  });
});
