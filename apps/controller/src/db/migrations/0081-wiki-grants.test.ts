/**
 * Tests what the migration that gives the shipped profiles `wiki.read` and
 * `wiki.write` does to profiles that already exist.
 *
 * Seeding cannot do this: it inserts a profile only if it is absent, so an
 * installed profile would keep the grants it was seeded with. The tests cover
 * the states a database can be in:
 *
 * - the shipped profiles without the grants;
 * - a shipped profile that already has one of them;
 * - a profile that is not one of the three;
 * - a custom profile the user gave a shipped name.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import wikiGrants from "./0081-wiki-grants";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 81);

/**
 * The migrations up to and including the one under test. A later migration
 * may change the same profiles, so the test stops here.
 */
const THROUGH = migrations.filter(([id]) => id <= 81);

const at = "2026-10-01T00:00:00.000Z";

interface Seeded {
  readonly name: string;
  readonly grants: ReadonlyArray<string>;
  readonly shipped: boolean;
}

/** Reads every profile's grants and `updated_at`, by name. */
const readProfiles = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
});

/**
 * Writes the profiles at the previous head, runs the migration, and returns
 * what `read` reads afterwards.
 */
const seedAndMigrate = <A>(
  seeded: ReadonlyArray<Seeded>,
  read: Effect.Effect<A, SqlError, SqlClient.SqlClient>,
): Promise<A> =>
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
      return yield* read;
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

/** The profiles an older build seeded, written the way that build wrote them. */
const SHIPPED: ReadonlyArray<Seeded> = [
  { name: "assistant", grants: ["task.read", "notification.write"], shipped: true },
  { name: "worker", grants: ["task.read", "event.read"], shipped: true },
  // Already has one grant: a user added it by hand before upgrading.
  { name: "unrestricted", grants: ["task.read", "wiki.read"], shipped: true },
  { name: "reviewer", grants: ["task.read"], shipped: false },
];

describe("wiki grants on the shipped profiles seeded before they existed", () => {
  it("adds both to assistant and worker, keeps the other grants, and updates updated_at", async () => {
    const profiles = await seedAndMigrate(SHIPPED, readProfiles);

    expect(profiles.get("assistant")?.grants).toEqual([
      "task.read",
      "notification.write",
      "wiki.read",
      "wiki.write",
    ]);
    expect(profiles.get("worker")?.grants).toEqual([
      "task.read",
      "event.read",
      "wiki.read",
      "wiki.write",
    ]);
    // The rows changed, so their updated_at is no longer the first-run time.
    expect(profiles.get("assistant")?.updatedAt).not.toBe(at);
    expect(profiles.get("worker")?.updatedAt).not.toBe(at);
  });

  it("adds only the missing grant to a profile that already has one", async () => {
    const profiles = await seedAndMigrate(SHIPPED, readProfiles);

    expect(profiles.get("unrestricted")?.grants).toEqual(["task.read", "wiki.read", "wiki.write"]);
  });

  it("changes nothing when it runs a second time", async () => {
    // The migrator never runs a migration twice, so the test runs it directly.
    const [first, second] = await seedAndMigrate(
      SHIPPED,
      Effect.gen(function* () {
        const first = yield* readProfiles;
        yield* wikiGrants;
        return [first, yield* readProfiles] as const;
      }),
    );

    expect(second).toEqual(first);
  });

  it("adds them to no other profile", async () => {
    const profiles = await seedAndMigrate(SHIPPED, readProfiles);

    expect(profiles.get("reviewer")).toEqual({ grants: ["task.read"], updatedAt: at });
  });

  it("leaves a custom profile with a shipped name unchanged when the shipped one was renamed", async () => {
    // Names are unique, so a user who wants their own `worker` has renamed
    // the shipped one first. This migration must not widen a profile the user
    // wrote themselves.
    const profiles = await seedAndMigrate(
      [
        { name: "helper", grants: ["task.read"], shipped: true },
        { name: "worker", grants: ["task.read"], shipped: false },
      ],
      readProfiles,
    );

    expect(profiles.get("worker")).toEqual({ grants: ["task.read"], updatedAt: at });
    expect(profiles.get("helper")).toEqual({ grants: ["task.read"], updatedAt: at });
  });
});
