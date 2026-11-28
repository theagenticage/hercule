/**
 * Tests what the project model profile migration does to a database at the
 * previous head: existing projects keep their rows and read with no profile,
 * and the new column holds a profile id that deleting the profile clears.
 *
 * The tests stop at this migration, so a later migration cannot change what
 * they check.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 101);
const UP_TO_PROJECT_MODEL_PROFILE = migrations.filter(([id]) => id <= 101);

const PROJECT_ID = new Uint8Array(16).fill(0x11);
const PROFILE_ID = new Uint8Array(16).fill(0x22);
const AT = "2026-10-01T00:00:00.000Z";

const insertProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projects (id, name, created_at, updated_at)
             VALUES (${PROJECT_ID}, 'Existing', ${AT}, ${AT})`;
});

describe("the project model profile migration", () => {
  it("keeps an existing project and gives it no profile", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertProject;
        yield* runMigrations(UP_TO_PROJECT_MODEL_PROFILE);
        return yield* sql<{ readonly name: string; readonly model_profile_id: Uint8Array | null }>`
          SELECT name, model_profile_id FROM projects
        `;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(rows).toEqual([{ name: "Existing", model_profile_id: null }]);
  });

  it("clears the column when the profile is deleted", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_PROJECT_MODEL_PROFILE);
        yield* sql`INSERT INTO model_profiles (id, name, revision, body, created_at, updated_at)
                   VALUES (${PROFILE_ID}, 'Review', 1, '{}', ${AT}, ${AT})`;
        yield* insertProject;
        yield* sql`UPDATE projects SET model_profile_id = ${PROFILE_ID}`;
        yield* sql`DELETE FROM model_profiles WHERE id = ${PROFILE_ID}`;
        return yield* sql<{ readonly model_profile_id: Uint8Array | null }>`
          SELECT model_profile_id FROM projects
        `;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(rows).toEqual([{ model_profile_id: null }]);
  });
});
