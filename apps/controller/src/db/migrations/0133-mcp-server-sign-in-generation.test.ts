/**
 * Tests what the migration that adds `mcp_servers.sign_in_generation` does to
 * a database at the previous head: a server that exists starts at generation 0
 * and keeps everything else, and a new server starts at 0 as well.
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

const BEFORE = migrations.filter(([id]) => id < 133);
const UP_TO_SIGN_IN_GENERATION = migrations.filter(([id]) => id <= 133);

const AT = "2026-11-01T00:00:00.000Z";
const URL_SERVER = "0199e0e77b217000800000000000b001";
const NEW_URL_SERVER = "0199e0e77b217000800000000000b002";

const insertUrlServer = (id: string, normalizedUrl: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO mcp_servers
        (id, name, source_kind, url, normalized_url, sign_in, enabled, status, revision, created_at,
         updated_at, tools)
      VALUES
        (unhex(${id}), 'remote', 'url', ${normalizedUrl}, ${normalizedUrl}, 'token', 1, 'ready', 4,
         ${AT}, ${AT}, '[{"name":"search","description":"","inputSchema":{}}]')`,
  );

describe("the MCP server sign-in generation migration", () => {
  it("starts an existing server at generation 0 and keeps its other columns", async () => {
    const { before, after } = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertUrlServer(URL_SERVER, "https://mcp.example/mcp");
        const read = sql<Record<string, unknown>>`
          SELECT hex(id) AS id, name, url, sign_in, status, revision, tools FROM mcp_servers`;
        const before = yield* read;
        yield* runMigrations(UP_TO_SIGN_IN_GENERATION);
        const after = yield* read;
        return {
          before,
          after: {
            rows: after,
            generations: yield* sql`SELECT sign_in_generation FROM mcp_servers`,
          },
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(after.rows).toEqual(before);
    expect(after.generations).toEqual([{ sign_in_generation: 0 }]);
  });

  it("starts a new server at generation 0", async () => {
    const generations = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_SIGN_IN_GENERATION);
        yield* insertUrlServer(NEW_URL_SERVER, "https://other.example/mcp");
        return yield* sql`SELECT sign_in_generation FROM mcp_servers`;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(generations).toEqual([{ sign_in_generation: 0 }]);
  });
});
