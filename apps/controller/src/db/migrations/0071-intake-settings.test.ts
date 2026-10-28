/**
 * Tests what the Intake settings migration does to a database at the previous
 * head:
 *
 * - a plugin and a Connection that already exist get empty Intake overrides;
 * - both columns refuse text that is not JSON.
 *
 * The tests stop at this migration, so a later migration cannot change what
 * they check.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import { TestDatabaseWriter } from "../testing";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 71);

/** The migrations up to and including the one under test. */
const UP_TO_INTAKE_SETTINGS = migrations.filter(([id]) => id <= 71);

const at = "2026-10-11T00:00:00.000Z";

/** The id of the connection a test writes. */
const CONNECTION_ID = new Uint8Array(16).fill(7);

const NO_OVERRIDES = '{"eventKinds":{},"signalKinds":{}}';

/** Runs an effect against a fresh temporary database. Rejects with any defect. */
const runOnFreshDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(TestDatabaseWriter), Effect.orDie));

describe("the Intake settings migration", () => {
  it("gives an existing plugin and Connection no overrides, and refuses text that is not JSON", async () => {
    const checked = await runOnFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`
          INSERT INTO plugins (id, enabled, config, created_at, updated_at)
          VALUES ('github', 1, '{}', ${at}, ${at})`;
        yield* sql`
          INSERT INTO connections
            (id, plugin_id, type, label, display_name, account_id, status, labels, config,
             created_at, updated_at)
          VALUES
            (${CONNECTION_ID}, 'github', 'github/github', 'work', 'octocat', '1', 'connected',
             '[]', '{}', ${at}, ${at})`;
        yield* runMigrations(UP_TO_INTAKE_SETTINGS);
        const [plugin] = yield* sql<{ readonly intake: string }>`SELECT intake FROM plugins`;
        const [connection] = yield* sql<{ readonly intake: string }>`
          SELECT intake FROM connections`;

        const pluginNotJson = yield* Effect.result(
          sql`UPDATE plugins SET intake = 'not json' WHERE id = 'github'`,
        );
        const connectionNotJson = yield* Effect.result(
          sql`UPDATE connections SET intake = 'not json'`,
        );
        return { plugin, connection, pluginNotJson, connectionNotJson };
      }),
    );

    expect(checked.plugin?.intake).toBe(NO_OVERRIDES);
    expect(checked.connection?.intake).toBe(NO_OVERRIDES);
    expect(Result.isFailure(checked.pluginNotJson)).toBe(true);
    expect(Result.isFailure(checked.connectionNotJson)).toBe(true);
  });
});
