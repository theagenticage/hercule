/**
 * Tests what the migration that adds the columns for created OAuth clients
 * does to a database at the previous head: a Connection and a pending flow
 * that exist keep every column they had and start with the new columns empty,
 * so an old flow still reads as one that returns to the controller and was
 * started by the user.
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

const BEFORE = migrations.filter(([id]) => id < 135);
const UP_TO_CREATED_CLIENTS = migrations.filter(([id]) => id <= 135);

const AT = "2026-11-01T00:00:00.000Z";
const EXPIRES_AT = "2026-11-01T00:10:00.000Z";
const CONNECTION_ID = new Uint8Array(16).fill(7);

describe("the created OAuth clients migration", () => {
  it("leaves a Connection and a pending flow as they were, with the new columns empty", async () => {
    const { before, after } = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`
          INSERT INTO connections
            (id, plugin_id, type, label, display_name, account_id, status, labels, config,
             created_at, updated_at)
          VALUES
            (${CONNECTION_ID}, 'linear', 'linear/linear', 'work', 'Ada', 'u-1', 'connected', '[]',
             '{}', ${AT}, ${AT})`;
        yield* sql`
          INSERT INTO oauth_setups
            (state, type, connection_id, label, labels, config, origin, code_verifier,
             expires_at, created_at)
          VALUES
            ('state-1', 'linear/linear', ${CONNECTION_ID}, NULL, NULL, NULL, 'https://h.test',
             'verifier-1', ${EXPIRES_AT}, ${AT})`;
        const readOld = Effect.all({
          connections: sql`
            SELECT label, display_name, account_id, status, credentials_generation FROM connections`,
          setups: sql`
            SELECT state, type, origin, code_verifier, expires_at FROM oauth_setups`,
        });
        const before = yield* readOld;
        yield* runMigrations(UP_TO_CREATED_CLIENTS);
        return {
          before,
          after: {
            old: yield* readOld,
            connections: yield* sql`SELECT oauth_client_id FROM connections`,
            setups: yield* sql`
              SELECT client_id, redirect_uri, actor, credentials_generation FROM oauth_setups`,
          },
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(after.old).toEqual(before);
    expect(after.connections).toEqual([{ oauth_client_id: null }]);
    expect(after.setups).toEqual([
      { client_id: null, redirect_uri: null, actor: null, credentials_generation: null },
    ]);
  });
});
