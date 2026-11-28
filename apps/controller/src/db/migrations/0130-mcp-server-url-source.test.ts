/**
 * Tests what the migration that lets an MCP Server come from an address does
 * to a database at the previous head: the servers and both lists that name
 * them survive the rebuild of `mcp_servers`, a server of either kind is
 * accepted only with the columns of its kind, an address is kept once, and a
 * secret may belong to an MCP Server.
 *
 * The tests stop at this migration, so a later migration cannot change what
 * they check.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 130);
const UP_TO_URL_SOURCE = migrations.filter(([id]) => id <= 130);

const AT = "2026-11-01T00:00:00.000Z";
const LATER = "2026-11-02T00:00:00.000Z";

const PLUGIN_SERVER = "0199e0e77b217000800000000000a001";
const SECOND_PLUGIN_SERVER = "0199e0e77b217000800000000000a002";
const URL_SERVER = "0199e0e77b217000800000000000b001";
const SECOND_URL_SERVER = "0199e0e77b217000800000000000b002";
const SWITCHED_OFF_SERVER = "0199e0e77b217000800000000000a004";

/** Writes a Connection, a Project and a Session, which the servers and their lists refer to. */
const insertOwners = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO connections (id, plugin_id, type, label, display_name, account_id, status,
                             labels, config, created_at, updated_at)
    VALUES (x'01', 'acme', 'acme/desk', 'work', 'Desk', 'desk-1', 'connected', '[]', '{}',
            ${AT}, ${AT})`;
  yield* sql`INSERT INTO projects (id, name, created_at, updated_at) VALUES (x'02', 'p', ${AT}, ${AT})`;
  yield* sql`
    INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash,
                         created_at, updated_at)
    VALUES ('runner', 'laptop', 'online', 'active', 0, '{}', 'hash', ${AT}, ${AT})`;
  yield* sql`
    INSERT INTO workspaces (id, runner_id, kind, status, created_at, ownership, warnings)
    VALUES ('workspace', 'runner', 'ephemeral', 'ready', ${AT}, 'managed', '[]')`;
  yield* sql`
    INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id, workspace_id,
                          requested_access_mode, access_mode, spec, title, status, created_at,
                          last_activity_at)
    VALUES ('session', 'profile', 'provider', 'runner', 'workspace', 'default', 'default', '{}',
            'thread', 'exited', ${AT}, ${AT})`;
});

/** Writes a plugin server in the shape the previous head stores, with every optional column set. */
const insertPluginServerBefore = (id: string, contributionId: string, accountId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`
      INSERT INTO mcp_servers
        (id, name, contribution_id, connection_id, account_id, enabled, status, status_detail,
         status_cause, checked_at, protocol_version, revision, connection_generation,
         notified_status, next_check_at, failed_checks, created_at, updated_at, tools)
      VALUES
        (unhex(${id}), 'desk', ${contributionId}, x'01', ${accountId}, 1, 'error', 'a detail',
         'connection', ${AT}, '2025-11-25', 7, 3, 'error', ${AT}, 2, ${AT}, ${AT},
         '[{"name":"search","description":"","inputSchema":{}}]')`,
  );

/**
 * Writes a plugin server that is switched off and has every optional column
 * null, which the copy must keep null and not turn into an empty string.
 */
const insertSwitchedOffPluginServerBefore = (id: string, contributionId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`
      INSERT INTO mcp_servers
        (id, name, contribution_id, connection_id, account_id, enabled, status, status_detail,
         status_cause, checked_at, protocol_version, notified_status, next_check_at, created_at,
         updated_at)
      VALUES
        (unhex(${id}), 'off', ${contributionId}, x'01', 'desk-2', 0, 'checking', NULL, NULL,
         NULL, NULL, NULL, NULL, ${AT}, ${AT})`,
  );

/** Reads what the migration must not change in a server row. */
const readServers = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<Record<string, unknown>>`
    SELECT hex(id) AS id, name, hex(connection_id) AS connection_id, contribution_id, account_id,
           enabled, status, status_detail, status_cause, checked_at, protocol_version, revision,
           connection_generation, notified_status, next_check_at, failed_checks, created_at,
           updated_at, tools
    FROM mcp_servers ORDER BY id`,
);

/** Inserts a URL server with the columns given, and returns whether the table accepted it. */
const insertUrlServer = (
  id: string,
  normalizedUrl: string | null,
  extra: { readonly accountId?: string } = {},
) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      Effect.exit(
        sql`
          INSERT INTO mcp_servers
            (id, name, source_kind, account_id, url, normalized_url, sign_in, enabled, status,
             created_at, updated_at)
          VALUES
            (unhex(${id}), 'linear', 'url', ${extra.accountId ?? null}, 'https://mcp.example/mcp',
             ${normalizedUrl}, 'none', 1, 'checking', ${AT}, ${AT})`,
      ),
      Exit.isSuccess,
    ),
  );

describe("the MCP server URL source migration", () => {
  it("keeps the plugin servers, both lists that name them and the secrets, as they were", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertOwners;
        yield* insertPluginServerBefore(PLUGIN_SERVER, "acme/desk", "desk-1");
        yield* insertPluginServerBefore(SECOND_PLUGIN_SERVER, "acme/other", "desk-1");
        yield* insertSwitchedOffPluginServerBefore(SWITCHED_OFF_SERVER, "acme/off");
        yield* sql`
          INSERT INTO project_mcp_servers (project_id, position, mcp_server_id)
          VALUES (x'02', 0, unhex(${SECOND_PLUGIN_SERVER})), (x'02', 1, unhex(${PLUGIN_SERVER}))`;
        yield* sql`
          INSERT INTO session_mcp_servers (session_id, position, mcp_server_id, left_out)
          VALUES ('session', 0, unhex(${PLUGIN_SERVER}), 'needs-sign-in'),
                 ('session', 1, unhex(${SECOND_PLUGIN_SERVER}), NULL)`;
        yield* sql`
          INSERT INTO secrets (id, owner_kind, owner_id, name, nonce, ciphertext, created_at)
          VALUES (x'10', 'connection', 'c', 'token', x'aa', x'bb', ${AT})`;
        yield* sql`
          INSERT INTO secrets (id, owner_kind, owner_id, name, nonce, ciphertext, created_at,
                               rotated_at)
          VALUES (x'11', 'connection', 'c', 'rotated', x'cc', x'dd', ${AT}, ${LATER})`;
        const before = yield* readServers;

        yield* runMigrations(UP_TO_URL_SOURCE);

        return {
          before,
          after: yield* readServers,
          sourceKinds: yield* sql<{ readonly source_kind: string }>`
            SELECT source_kind FROM mcp_servers ORDER BY id`,
          projectList: yield* sql<Record<string, unknown>>`
            SELECT hex(project_id) AS project_id, position, hex(mcp_server_id) AS server
            FROM project_mcp_servers ORDER BY position`,
          sessionList: yield* sql<Record<string, unknown>>`
            SELECT session_id, position, hex(mcp_server_id) AS server, left_out
            FROM session_mcp_servers ORDER BY position`,
          secret: yield* sql<Record<string, unknown>>`
            SELECT hex(id) AS id, owner_kind, owner_id, name, hex(nonce) AS nonce,
                   hex(ciphertext) AS ciphertext, created_at, rotated_at
            FROM secrets ORDER BY id`,
          columns: yield* sql<{ readonly name: string }>`
            SELECT name FROM pragma_table_info('mcp_servers') ORDER BY cid`,
          // `pragma_foreign_key_list` is the table-valued form of `PRAGMA foreign_key_list`.
          projectListReferences: yield* sql<{ readonly table: string }>`
            SELECT "table" FROM pragma_foreign_key_list('project_mcp_servers') ORDER BY "table"`,
          sessionListReferences: yield* sql<{ readonly table: string }>`
            SELECT "table" FROM pragma_foreign_key_list('session_mcp_servers') ORDER BY "table"`,
          violations: yield* sql`SELECT * FROM pragma_foreign_key_check`,
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(result.after).toEqual(result.before);
    expect(result.after).toHaveLength(3);
    // The switched-off server's optional columns are still null, not ''.
    expect(result.after.find((row) => row.name === "off")).toMatchObject({
      enabled: 0,
      status_detail: null,
      status_cause: null,
      checked_at: null,
      protocol_version: null,
      notified_status: null,
      next_check_at: null,
    });
    expect(result.sourceKinds).toEqual([
      { source_kind: "plugin" },
      { source_kind: "plugin" },
      { source_kind: "plugin" },
    ]);
    // `tools` stays the last column, so a read that leaves it out skips its overflow pages.
    expect(result.columns.at(-1)).toEqual({ name: "tools" });
    expect(result.projectList).toEqual([
      { project_id: "02", position: 0, server: SECOND_PLUGIN_SERVER.toUpperCase() },
      { project_id: "02", position: 1, server: PLUGIN_SERVER.toUpperCase() },
    ]);
    expect(result.sessionList).toEqual([
      {
        session_id: "session",
        position: 0,
        server: PLUGIN_SERVER.toUpperCase(),
        left_out: "needs-sign-in",
      },
      {
        session_id: "session",
        position: 1,
        server: SECOND_PLUGIN_SERVER.toUpperCase(),
        left_out: null,
      },
    ]);
    expect(result.secret).toEqual([
      {
        id: "10",
        owner_kind: "connection",
        owner_id: "c",
        name: "token",
        nonce: "AA",
        ciphertext: "BB",
        created_at: AT,
        rotated_at: null,
      },
      {
        id: "11",
        owner_kind: "connection",
        owner_id: "c",
        name: "rotated",
        nonce: "CC",
        ciphertext: "DD",
        created_at: AT,
        rotated_at: LATER,
      },
    ]);
    expect(result.projectListReferences).toEqual([{ table: "mcp_servers" }, { table: "projects" }]);
    expect(result.sessionListReferences).toEqual([{ table: "mcp_servers" }, { table: "sessions" }]);
    expect(result.violations).toEqual([]);
  });

  it("keeps the old rules: one server per contribution and account, and lists that name a real server", async () => {
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_URL_SOURCE);
        yield* insertOwners;
        yield* sql`
          INSERT INTO mcp_servers
            (id, name, source_kind, contribution_id, connection_id, account_id, enabled, status,
             created_at, updated_at)
          VALUES (unhex(${PLUGIN_SERVER}), 'desk', 'plugin', 'acme/desk', x'01', 'desk-1', 1,
                  'checking', ${AT}, ${AT})`;
        const duplicate = yield* Effect.exit(
          sql`
            INSERT INTO mcp_servers
              (id, name, source_kind, contribution_id, connection_id, account_id, enabled, status,
               created_at, updated_at)
            VALUES (unhex(${SECOND_PLUGIN_SERVER}), 'desk', 'plugin', 'acme/desk', x'01',
                    'desk-1', 1, 'checking', ${AT}, ${AT})`,
        );
        const unknownConnection = yield* Effect.exit(
          sql`
            INSERT INTO mcp_servers
              (id, name, source_kind, contribution_id, connection_id, account_id, enabled, status,
               created_at, updated_at)
            VALUES (unhex(${SECOND_PLUGIN_SERVER}), 'desk', 'plugin', 'acme/other', x'99',
                    'desk-2', 1, 'checking', ${AT}, ${AT})`,
        );
        const unknownServer = yield* Effect.exit(
          sql`
            INSERT INTO project_mcp_servers (project_id, position, mcp_server_id)
            VALUES (x'02', 0, unhex(${SECOND_PLUGIN_SERVER}))`,
        );
        const index = yield* sql<{ readonly name: string }>`
          SELECT name FROM pragma_index_list('mcp_servers') WHERE name = 'mcp_servers_connection'`;
        return {
          duplicate: Exit.isSuccess(duplicate),
          unknownConnection: Exit.isSuccess(unknownConnection),
          unknownServer: Exit.isSuccess(unknownServer),
          index,
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(outcomes).toEqual({
      duplicate: false,
      unknownConnection: false,
      unknownServer: false,
      index: [{ name: "mcp_servers_connection" }],
    });
  });

  it("accepts a URL server with its columns and refuses a row that mixes the two kinds", async () => {
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_URL_SOURCE);
        yield* insertOwners;
        const accepted = yield* insertUrlServer(URL_SERVER, "https://mcp.example/mcp");
        const withAccount = yield* insertUrlServer(SECOND_URL_SERVER, "https://other.example", {
          accountId: "desk-1",
        });
        const withoutAddress = yield* insertUrlServer(SECOND_URL_SERVER, null);
        const pluginWithAddress = yield* Effect.exit(
          sql`
            INSERT INTO mcp_servers
              (id, name, source_kind, contribution_id, connection_id, account_id, url,
               normalized_url, sign_in, enabled, status, created_at, updated_at)
            VALUES (unhex(${PLUGIN_SERVER}), 'desk', 'plugin', 'acme/desk', x'01', 'desk-1',
                    'https://a.example', 'https://a.example', 'none', 1, 'checking', ${AT}, ${AT})`,
        );
        const pluginWithoutConnection = yield* Effect.exit(
          sql`
            INSERT INTO mcp_servers
              (id, name, source_kind, contribution_id, account_id, enabled, status, created_at,
               updated_at)
            VALUES (unhex(${PLUGIN_SERVER}), 'desk', 'plugin', 'acme/desk', 'desk-1', 1,
                    'checking', ${AT}, ${AT})`,
        );
        const urlWithoutSignIn = yield* Effect.exit(
          sql`
            INSERT INTO mcp_servers
              (id, name, source_kind, url, normalized_url, enabled, status, created_at,
               updated_at)
            VALUES (unhex(${SECOND_URL_SERVER}), 'linear', 'url', 'https://b.example',
                    'https://b.example', 1, 'checking', ${AT}, ${AT})`,
        );
        const unknownKind = yield* Effect.exit(
          sql`
            INSERT INTO mcp_servers
              (id, name, source_kind, url, normalized_url, sign_in, enabled, status, created_at,
               updated_at)
            VALUES (unhex(${SECOND_URL_SERVER}), 'linear', 'ftp', 'https://b.example',
                    'https://b.example', 'none', 1, 'checking', ${AT}, ${AT})`,
        );
        const unknownSignIn = yield* Effect.exit(
          sql`
            INSERT INTO mcp_servers
              (id, name, source_kind, url, normalized_url, sign_in, sign_in_offered, enabled,
               status, created_at, updated_at)
            VALUES (unhex(${SECOND_URL_SERVER}), 'linear', 'url', 'https://b.example',
                    'https://b.example', 'oauth', 'basic', 1, 'checking', ${AT}, ${AT})`,
        );
        return {
          accepted,
          withAccount,
          withoutAddress,
          pluginWithAddress: Exit.isSuccess(pluginWithAddress),
          pluginWithoutConnection: Exit.isSuccess(pluginWithoutConnection),
          urlWithoutSignIn: Exit.isSuccess(urlWithoutSignIn),
          unknownKind: Exit.isSuccess(unknownKind),
          unknownSignIn: Exit.isSuccess(unknownSignIn),
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(outcomes).toEqual({
      accepted: true,
      withAccount: false,
      withoutAddress: false,
      pluginWithAddress: false,
      pluginWithoutConnection: false,
      urlWithoutSignIn: false,
      unknownKind: false,
      unknownSignIn: false,
    });
  });

  it("keeps an address once, and lets plugin servers share the empty address", async () => {
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_URL_SOURCE);
        yield* insertOwners;
        const first = yield* insertUrlServer(URL_SERVER, "https://mcp.example/mcp");
        const sameAddress = yield* insertUrlServer(SECOND_URL_SERVER, "https://mcp.example/mcp");
        const otherAddress = yield* insertUrlServer(SECOND_URL_SERVER, "https://mcp.example/other");
        yield* sql`
          INSERT INTO mcp_servers
            (id, name, source_kind, contribution_id, connection_id, account_id, enabled, status,
             created_at, updated_at)
          VALUES (unhex(${PLUGIN_SERVER}), 'desk', 'plugin', 'acme/desk', x'01', 'desk-1', 1,
                  'checking', ${AT}, ${AT}),
                 (unhex('0199e0e77b217000800000000000a003'), 'desk', 'plugin', 'acme/other',
                  x'01', 'desk-1', 1, 'checking', ${AT}, ${AT})`;
        return { first, sameAddress, otherAddress };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(outcomes).toEqual({ first: true, sameAddress: false, otherAddress: true });
  });

  it("lets a list name a URL server", async () => {
    const lists = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_URL_SOURCE);
        yield* insertOwners;
        yield* insertUrlServer(URL_SERVER, "https://mcp.example/mcp");
        yield* sql`
          INSERT INTO project_mcp_servers (project_id, position, mcp_server_id)
          VALUES (x'02', 0, unhex(${URL_SERVER}))`;
        return yield* sql`SELECT * FROM project_mcp_servers`;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(lists).toHaveLength(1);
  });

  it("lets a secret belong to an MCP Server, once per name, and still refuses an unknown owner kind", async () => {
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_URL_SOURCE);
        const insertSecret = (id: string, ownerKind: string, ownerId: string, name: string) =>
          Effect.map(
            Effect.exit(
              sql`
                INSERT INTO secrets (id, owner_kind, owner_id, name, nonce, ciphertext, created_at)
                VALUES (unhex(${id}), ${ownerKind}, ${ownerId}, ${name}, x'aa', x'bb', ${AT})`,
            ),
            Exit.isSuccess,
          );
        return {
          mcpServer: yield* insertSecret("11", "mcp-server", URL_SERVER, "token"),
          sameName: yield* insertSecret("12", "mcp-server", URL_SERVER, "token"),
          otherName: yield* insertSecret("13", "mcp-server", URL_SERVER, "oauth.tokens"),
          unknownKind: yield* insertSecret("14", "stranger", URL_SERVER, "token"),
          earlierKind: yield* insertSecret("15", "provider-account", "a", "apiKey"),
          indexes: yield* sql<{ readonly name: string }>`
            SELECT name FROM pragma_index_list('secrets')
            WHERE name IN ('secrets_owner_name', 'secrets_name') ORDER BY name`,
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(outcomes).toEqual({
      mcpServer: true,
      sameName: false,
      otherName: true,
      unknownKind: false,
      earlierKind: true,
      indexes: [{ name: "secrets_name" }, { name: "secrets_owner_name" }],
    });
  });
});
