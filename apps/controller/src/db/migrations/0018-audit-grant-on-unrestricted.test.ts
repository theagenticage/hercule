/**
 * What the audit-grant migration does to profiles a database already holds.
 *
 * Seeding cannot do this: it is insert-if-absent, so an installed
 * `unrestricted` would keep the grant list it was seeded with and quietly stop
 * being parity with the user. The cases below are the states a database arrives
 * in: the shipped profile without the grant, a profile that already holds it,
 * the profiles meant to lack it, and a custom profile the user gave that name.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** Everything before the migration under test. */
const BEFORE = migrations.filter(([id]) => id < 18);

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

/** The profiles as they stand once the migration has run over them. */
const migrated = (seeded: ReadonlyArray<Seeded>): Promise<ReadonlyMap<string, Read>> =>
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
      yield* runMigrations();
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

/** The profiles an older build seeded, written as that build wrote them. */
const SHIPPED: ReadonlyArray<Seeded> = [
  { name: "unrestricted", grants: ["task.read", "event.read", "credential.write"], shipped: true },
  // Already holding it: a user who added the grant by hand before upgrading.
  { name: "auditor", grants: ["event.read", "event.audit"], shipped: false },
  { name: "worker", grants: ["task.read", "event.read"], shipped: true },
];

describe("event.audit on a database that was seeded before it existed", () => {
  it("gives it to unrestricted, keeping the rest of its grants, and says when", async () => {
    const profiles = await migrated(SHIPPED);

    expect(profiles.get("unrestricted")?.grants).toEqual([
      "task.read",
      "event.read",
      "credential.write",
      "event.audit",
    ]);
    // The row changed, so it stops claiming it was last touched at first run.
    expect(profiles.get("unrestricted")?.updatedAt).not.toBe(at);
  });

  it("leaves a profile that already holds it alone", async () => {
    const profiles = await migrated(SHIPPED);

    expect(profiles.get("auditor")).toEqual({
      grants: ["event.read", "event.audit"],
      updatedAt: at,
    });
  });

  it("gives it to no other profile", async () => {
    const profiles = await migrated(SHIPPED);

    expect(profiles.get("worker")).toEqual({
      grants: ["task.read", "event.read"],
      updatedAt: at,
    });
  });

  it("leaves a custom profile of that name alone, however the shipped one was renamed", async () => {
    // A name is unique, so the user who wants their own `unrestricted` has
    // renamed the shipped one first. Widening a profile they wrote themselves
    // is not this migration's to do.
    const profiles = await migrated([
      { name: "everything", grants: ["task.read"], shipped: true },
      { name: "unrestricted", grants: ["task.read"], shipped: false },
    ]);

    expect(profiles.get("unrestricted")).toEqual({ grants: ["task.read"], updatedAt: at });
    expect(profiles.get("everything")).toEqual({ grants: ["task.read"], updatedAt: at });
  });
});
