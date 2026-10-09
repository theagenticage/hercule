/**
 * Tests what the profile-grants-once migration does to profiles that already
 * exist: a repeated grant is kept once, where it first appeared, and a profile
 * without a repeat does not change.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 57);

const at = "2026-09-01T00:00:00.000Z";

interface Seeded {
  readonly name: string;
  readonly grants: ReadonlyArray<string>;
}

interface Read {
  readonly grants: ReadonlyArray<string>;
  readonly updatedAt: string;
}

/** Inserts the profiles, runs the migration, and returns the profiles after it, by name. */
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
                    ${profile.name}, ${JSON.stringify(profile.grants)}, 0, ${at}, ${at})`,
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

describe("profile grants on a database with repeated grants", () => {
  it("keeps each repeated grant once, where it first appeared", async () => {
    const profiles = await seedAndMigrate([
      {
        name: "operator",
        grants: ["task.read", "run.read", "task.read", "task.write", "run.read"],
      },
    ]);

    expect(profiles.get("operator")?.grants).toEqual(["task.read", "run.read", "task.write"]);
    expect(profiles.get("operator")?.updatedAt).not.toBe(at);
  });

  it("leaves a profile without a repeat as it was", async () => {
    const profiles = await seedAndMigrate([
      { name: "reader", grants: ["run.read", "task.read"] },
      { name: "empty", grants: [] },
    ]);

    expect(profiles.get("reader")).toEqual({ grants: ["run.read", "task.read"], updatedAt: at });
    expect(profiles.get("empty")).toEqual({ grants: [], updatedAt: at });
  });
});
