/**
 * Tests what the run-start-grant migration does to profiles that already
 * exist: each old grant becomes `run.start`, once, and a profile with neither
 * old grant does not change.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 26);

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

describe("run.start on a database seeded with workflow.run and workflow.submit", () => {
  it("replaces both old grants with one run.start where the first one was", async () => {
    const profiles = await seedAndMigrate([
      {
        name: "assistant",
        grants: ["task.read", "workflow.read", "workflow.run", "workflow.submit", "run.read"],
      },
    ]);

    expect(profiles.get("assistant")?.grants).toEqual([
      "task.read",
      "workflow.read",
      "run.start",
      "run.read",
    ]);
    expect(profiles.get("assistant")?.updatedAt).not.toBe(at);
  });

  it("gives run.start to a profile that held only one of the old grants", async () => {
    const profiles = await seedAndMigrate([
      { name: "starter", grants: ["workflow.run", "run.read"] },
      { name: "submitter", grants: ["run.read", "workflow.submit"] },
    ]);

    expect(profiles.get("starter")?.grants).toEqual(["run.start", "run.read"]);
    expect(profiles.get("submitter")?.grants).toEqual(["run.read", "run.start"]);
  });

  it("leaves a profile with neither old grant unchanged", async () => {
    const profiles = await seedAndMigrate([{ name: "worker", grants: ["task.read", "run.read"] }]);

    expect(profiles.get("worker")).toEqual({ grants: ["task.read", "run.read"], updatedAt: at });
  });
});
