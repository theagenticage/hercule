/**
 * Tests what the connection ingest migration does to a database at the
 * previous head:
 *
 * - a Connection that already exists gets an empty `feed_intervals` object;
 * - `connection_state` refuses an empty key and a value that is not JSON;
 * - deleting a Connection deletes its `connection_state` rows.
 *
 * The tests stop at this migration, so a later migration cannot change what
 * they check.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 42);

/** The migrations up to and including the one under test. */
const UP_TO_CONNECTION_INGEST = migrations.filter(([id]) => id <= 42);

const at = "2026-09-01T00:00:00.000Z";

/** The id of the connection a test writes. */
const CONNECTION_ID = new Uint8Array(16).fill(7);

/** Runs an effect against a fresh in-memory database. Rejects with any defect. */
const runOnFreshDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie));

describe("the connection ingest migration", () => {
  it("gives an existing Connection no feed intervals, and deletes its state with it", async () => {
    const checked = await runOnFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`
          INSERT INTO connections
            (id, plugin_id, type, label, display_name, account_id, status, labels, config,
             created_at, updated_at)
          VALUES
            (${CONNECTION_ID}, 'github', 'github/github', 'work', 'octocat', '1', 'connected',
             '[]', '{}', ${at}, ${at})`;
        yield* runMigrations(UP_TO_CONNECTION_INGEST);
        const [connection] = yield* sql<{ readonly feed_intervals: string }>`
          SELECT feed_intervals FROM connections`;

        const emptyKey = yield* Effect.result(
          sql`INSERT INTO connection_state VALUES (${CONNECTION_ID}, '', '1')`,
        );
        const notJson = yield* Effect.result(
          sql`INSERT INTO connection_state VALUES (${CONNECTION_ID}, 'cursor', 'not json')`,
        );
        yield* sql`INSERT INTO connection_state VALUES (${CONNECTION_ID}, 'cursor', '{"at":1}')`;
        yield* sql`DELETE FROM connections WHERE id = ${CONNECTION_ID}`;
        const state = yield* sql`SELECT key FROM connection_state`;
        return { connection, emptyKey, notJson, state };
      }),
    );

    expect(checked.connection?.feed_intervals).toBe("{}");
    expect(Result.isFailure(checked.emptyKey)).toBe(true);
    expect(Result.isFailure(checked.notJson)).toBe(true);
    expect(checked.state).toEqual([]);
  });
});
