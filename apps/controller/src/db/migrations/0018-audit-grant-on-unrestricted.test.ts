/**
 * Tests what the audit-grant migration does to profiles that already exist.
 *
 * Seeding cannot do this: it inserts a profile only if it is absent, so an
 * installed `unrestricted` would keep the grants it was seeded with and quietly
 * stop matching what the user can do. The tests cover the states a database
 * can be in:
 *
 * - the shipped profile without the grant;
 * - a profile that already has it;
 * - the profiles meant to lack it;
 * - a custom profile the user gave that name.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 18);

/**
 * The migrations up to and including the one under test. A later migration
 * may change the same profiles, so the test stops here.
 */
const THROUGH = migrations.filter(([id]) => id <= 18);

const at = "2026-09-01T00:00:00.000Z";

interface Seeded {
  readonly name: string;
  readonly grants: ReadonlyArray<string>;
  readonly shipped: boolean;
}

interface Read {
  readonly grants: ReadonlyArray<string>;
  readonly updatedAt: string;
}

/** Returns the profiles after the migration has run. */
const seedAndMigrate = (seeded: ReadonlyArray<Seeded>): Promise<ReadonlyMap<string, Read>> =>
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
  { name: "unrestricted", grants: ["task.read", "event.read", "credential.write"], shipped: true },
  // Already has the grant: a user added it by hand before upgrading.
  { name: "auditor", grants: ["event.read", "event.audit"], shipped: false },
  { name: "worker", grants: ["task.read", "event.read"], shipped: true },
];

describe("event.audit on a database that was seeded before it existed", () => {
  it("adds it to unrestricted, keeps the other grants, and updates updated_at", async () => {
    const profiles = await seedAndMigrate(SHIPPED);

    expect(profiles.get("unrestricted")?.grants).toEqual([
      "task.read",
      "event.read",
      "credential.write",
      "event.audit",
    ]);
    // The row changed, so its updated_at is no longer the first-run time.
    expect(profiles.get("unrestricted")?.updatedAt).not.toBe(at);
  });

  it("leaves a profile that already has it unchanged", async () => {
    const profiles = await seedAndMigrate(SHIPPED);

    expect(profiles.get("auditor")).toEqual({
      grants: ["event.read", "event.audit"],
      updatedAt: at,
    });
  });

  it("adds it to no other profile", async () => {
    const profiles = await seedAndMigrate(SHIPPED);

    expect(profiles.get("worker")).toEqual({
      grants: ["task.read", "event.read"],
      updatedAt: at,
    });
  });

  it("leaves a custom profile with that name unchanged when the shipped one was renamed", async () => {
    // Names are unique, so a user who wants their own `unrestricted` has
    // renamed the shipped one first. This migration must not widen a profile
    // the user wrote themselves.
    const profiles = await seedAndMigrate([
      { name: "everything", grants: ["task.read"], shipped: true },
      { name: "unrestricted", grants: ["task.read"], shipped: false },
    ]);

    expect(profiles.get("unrestricted")).toEqual({ grants: ["task.read"], updatedAt: at });
    expect(profiles.get("everything")).toEqual({ grants: ["task.read"], updatedAt: at });
  });
});
