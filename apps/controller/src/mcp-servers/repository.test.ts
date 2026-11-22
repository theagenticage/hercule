/**
 * Tests that the MCP Server repository reads a server of either source from
 * its row, and that the reads that look a server up by its plugin or its
 * Connection never match a server added by URL.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { inTransaction, TestDatabase } from "../db/testing";
import { mcpServerRepository } from "./repository";

const AT = "2026-11-01T00:00:00.000Z";
const CONNECTION_ID = "0199e0e7-7b21-7000-8000-000000000001";
const URL_SERVER_ID = "0199e0e7-7b21-7000-8000-000000000002";

/** Writes a Connection, a plugin server that uses it, and a server added by URL, then reads them back. */
const arrange = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const servers = yield* mcpServerRepository;
  yield* inTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO connections (id, plugin_id, type, label, display_name, account_id, status,
                                 labels, config, created_at, updated_at)
        VALUES (unhex(replace(${CONNECTION_ID}, '-', '')), 'acme', 'acme/desk', 'work', 'Desk',
                'desk-1', 'connected', '[]', '{}', ${AT}, ${AT})`;
      yield* servers.insertPlugin({
        name: "desk",
        contributionId: "acme/desk",
        connectionId: CONNECTION_ID,
        accountId: "desk-1",
        connectionGeneration: 0,
        at: AT,
      });
      yield* sql`
        INSERT INTO mcp_servers
          (id, name, source_kind, url, normalized_url, sign_in, sign_in_offered, enabled, status,
           created_at, updated_at)
        VALUES (unhex(replace(${URL_SERVER_ID}, '-', '')), 'linear', 'url',
                'https://mcp.linear.app/mcp/', 'https://mcp.linear.app/mcp', 'token', 'oauth', 1,
                'checking', ${AT}, ${AT})`;
    }),
  );
  return servers;
});

describe("the MCP Server repository", () => {
  it("reads a plugin server and a server added by URL with the source of their kind", async () => {
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const servers = yield* arrange;
        const all = yield* servers.list();
        const withoutTools = yield* servers.readMany(
          all.map((server) => server.id),
          "without-tools",
        );
        return { all, withoutTools: [...withoutTools.values()].map((server) => server.source) };
      }).pipe(Effect.provide(TestDatabase), Effect.scoped, Effect.orDie),
    );

    // The list is sorted by name: the plugin server `desk` before the URL server `linear`.
    expect(found.all.map((server) => server.source)).toEqual([
      {
        kind: "plugin",
        contributionId: "acme/desk",
        connectionId: CONNECTION_ID,
        accountId: "desk-1",
      },
      {
        kind: "url",
        url: "https://mcp.linear.app/mcp/",
        normalizedUrl: "https://mcp.linear.app/mcp",
        signIn: "token",
        signInOffered: "oauth",
      },
    ]);
    expect(found.withoutTools).toHaveLength(2);
  });

  it("never matches a server added by URL when it looks a server up by plugin or Connection", async () => {
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const servers = yield* arrange;
        return {
          byContribution: yield* servers.findByContributionAndAccount("acme/desk", "desk-1"),
          byConnection: (yield* servers.listByConnection(CONNECTION_ID)).map(
            (server) => server.name,
          ),
          dependencies: (yield* servers.listDependencyIds()).map((server) => server.contributionId),
          urlServer: yield* servers.readById(URL_SERVER_ID),
        };
      }).pipe(Effect.provide(TestDatabase), Effect.scoped, Effect.orDie),
    );

    expect(Option.map(found.byContribution, (server) => server.name)).toEqual(Option.some("desk"));
    expect(found.byConnection).toEqual(["desk"]);
    expect(found.dependencies).toEqual(["acme/desk"]);
    expect(Option.map(found.urlServer, (server) => server.id)).toEqual(Option.some(URL_SERVER_ID));
  });

  it("finds a server by its normalized address, and the table refuses a second server of one address", async () => {
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const servers = yield* arrange;
        const byAddress = yield* servers.findByNormalizedUrl("https://mcp.linear.app/mcp");
        const unknown = yield* servers.findByNormalizedUrl("https://mcp.other.app/mcp");
        const second = yield* Effect.flip(
          inTransaction(
            servers.insertUrl({
              name: "linear2",
              url: "https://MCP.linear.app/mcp",
              normalizedUrl: "https://mcp.linear.app/mcp",
              signIn: "none",
              at: AT,
            }),
          ),
        );
        return { byAddress, unknown, second };
      }).pipe(Effect.provide(TestDatabase), Effect.scoped, Effect.orDie),
    );

    expect(Option.map(found.byAddress, (server) => server.id)).toEqual(Option.some(URL_SERVER_ID));
    expect(Option.isNone(found.unknown)).toBe(true);
    expect(found.second.reason._tag).toBe("UniqueViolation");
  });

  it("reads every server of a name, sorted by id, and none for a name no server has", async () => {
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const servers = yield* arrange;
        // A second server may share a name: the name is unique per list, not per catalogue.
        yield* inTransaction(
          servers.insertUrl({
            name: "linear",
            url: "https://mcp.other.app/mcp",
            normalizedUrl: "https://mcp.other.app/mcp",
            signIn: "none",
            at: AT,
          }),
        );
        return {
          desk: (yield* servers.readByName("desk")).map((server) => server.id),
          linear: (yield* servers.readByName("linear")).map((server) => server.id),
          none: yield* servers.readByName("nothing"),
        };
      }).pipe(Effect.provide(TestDatabase), Effect.scoped, Effect.orDie),
    );

    expect(found.desk).toHaveLength(1);
    expect(found.linear).toHaveLength(2);
    expect(found.linear).toContain(URL_SERVER_ID);
    expect(found.linear).toEqual(found.linear.toSorted());
    expect(found.none).toEqual([]);
  });
});
