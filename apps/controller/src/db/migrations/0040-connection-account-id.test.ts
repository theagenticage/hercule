/**
 * Tests what the connection account id migration does to a database at the
 * previous head:
 *
 * - a database that holds a connection is refused with a message the user can
 *   act on, and stays at the previous schema;
 * - an empty `connections` table is rebuilt with a NOT NULL `account_id`, and
 *   the references to it from `resources` and `workspaces` still hold.
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
const BEFORE = migrations.filter(([id]) => id < 40);

/** The migrations up to and including the one under test. */
const UP_TO_CONNECTION_ACCOUNT_ID = migrations.filter(([id]) => id <= 40);

const at = "2026-09-01T00:00:00.000Z";

/** The id of the connection a test writes. */
const CONNECTION_ID = new Uint8Array(16).fill(7);

/** Runs an effect against a fresh in-memory database. Rejects with any defect. */
const runOnFreshDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie));

describe("the connection account id migration", () => {
  it("refuses a database that holds a connection, and leaves it at the previous schema", async () => {
    const { refusal, version, connections } = await runOnFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`
          INSERT INTO connections
            (id, plugin_id, type, label, display_name, status, labels, config,
             created_at, updated_at)
          VALUES
            (${CONNECTION_ID}, 'github', 'github/github', 'work', 'octocat', 'connected', '[]',
             '{}', ${at}, ${at})`;
        const refusal = yield* Effect.result(runMigrations(UP_TO_CONNECTION_ACCOUNT_ID));
        const [version] = yield* sql<{ readonly version: number }>`
          SELECT max(migration_id) AS version FROM effect_sql_migrations`;
        const connections = yield* sql<{ readonly display_name: string }>`
          SELECT display_name FROM connections`;
        return { refusal, version, connections };
      }),
    );

    expect(Result.isFailure(refusal) && refusal.failure).toMatchObject({
      _tag: "MigrationError",
      message: 'Migration "40_connection-account-id" failed',
      cause: {
        _tag: "ExistingConnectionsError",
        message:
          "This version stores the account each connection belongs to, and cannot add it to " +
          "the 1 existing connection. Start a fresh Hercule Home, or delete the connections " +
          "with the previous version first.",
      },
    });
    // The boot prints the cause's message only when the cause is an `Error`.
    expect(Result.isFailure(refusal) && refusal.failure.cause).toBeInstanceOf(Error);
    expect(version?.version).toBe(39);
    expect(connections).toEqual([{ display_name: "octocat" }]);
  });

  it("rebuilds an empty table with a required account_id, and keeps the references to it", async () => {
    const checked = await runOnFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_CONNECTION_ACCOUNT_ID);
        const accountId = yield* sql<{ readonly notnull: number }>`
          SELECT "notnull" FROM pragma_table_info('connections') WHERE name = 'account_id'`;
        const indexes = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'connections' AND sql IS NOT NULL`;
        const referencing = yield* sql<{ readonly name: string; readonly sql: string }>`
          SELECT name, sql FROM sqlite_master
          WHERE type = 'table' AND name IN ('resources', 'workspaces') ORDER BY name`;

        const insertWithoutAccountId = yield* Effect.result(
          sql`
            INSERT INTO connections
              (id, plugin_id, type, label, display_name, status, labels, config,
               created_at, updated_at)
            VALUES
              (${CONNECTION_ID}, 'github', 'github/github', 'work', 'octocat', 'connected', '[]',
               '{}', ${at}, ${at})`,
        );
        yield* sql`
          INSERT INTO connections
            (id, plugin_id, type, label, display_name, account_id, status, labels, config,
             created_at, updated_at)
          VALUES
            (${CONNECTION_ID}, 'github', 'github/github', 'work', 'octocat', '583231', 'connected',
             '[]', '{}', ${at}, ${at})`;
        yield* sql`
          INSERT INTO resources
            (id, kind, label, connection_id, workspace_include, created_at, updated_at)
          VALUES
            (${new Uint8Array(16).fill(1)}, 'mailbox', 'inbox', ${CONNECTION_ID}, 0, ${at}, ${at})`;
        // A reference to no connection is refused, so the foreign key points
        // at the rebuilt table rather than at a table that no longer exists.
        const insertWithUnknownConnection = yield* Effect.result(
          sql`
            INSERT INTO resources
              (id, kind, label, connection_id, workspace_include, created_at, updated_at)
            VALUES
              (${new Uint8Array(16).fill(2)}, 'mailbox', 'other', ${new Uint8Array(16).fill(9)}, 0,
               ${at}, ${at})`,
        );
        const violations = yield* sql`PRAGMA foreign_key_check`;
        return {
          accountId,
          indexes,
          referencing,
          insertWithoutAccountId,
          insertWithUnknownConnection,
          violations,
        };
      }),
    );

    expect(checked.accountId).toEqual([{ notnull: 1 }]);
    expect(checked.indexes).toEqual([{ name: "connections_by_plugin" }]);
    expect(checked.referencing.map((table) => table.name)).toEqual(["resources", "workspaces"]);
    for (const table of checked.referencing) {
      expect(table.sql).toContain("REFERENCES connections (id)");
    }
    expect(Result.isFailure(checked.insertWithoutAccountId)).toBe(true);
    expect(String(checked.insertWithoutAccountId)).toContain("NOT NULL");
    expect(Result.isFailure(checked.insertWithUnknownConnection)).toBe(true);
    expect(String(checked.insertWithUnknownConnection)).toContain("FOREIGN KEY");
    expect(checked.violations).toEqual([]);
  });
});
