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

  it("raises the sign-in generation for each new sign-in and for Replace, and for nothing else", async () => {
    const generations = await Effect.runPromise(
      Effect.gen(function* () {
        const servers = yield* arrange;
        const read = servers
          .readSignInGeneration(URL_SERVER_ID)
          .pipe(Effect.map(Option.getOrThrow));
        const steps: Array<number> = [yield* read];
        yield* inTransaction(servers.writeEnabled(URL_SERVER_ID, false, AT));
        yield* inTransaction(servers.resetSchedule(URL_SERVER_ID, AT));
        steps.push(yield* read);
        yield* inTransaction(servers.writeTokenSignIn(URL_SERVER_ID, AT));
        steps.push(yield* read);
        yield* inTransaction(servers.writeOAuthSignIn(URL_SERVER_ID, AT));
        steps.push(yield* read);
        yield* inTransaction(
          servers.writePluginSource(URL_SERVER_ID, {
            contributionId: "acme/other",
            connectionId: CONNECTION_ID,
            accountId: "desk-2",
            connectionGeneration: 0,
            enabled: true,
            at: AT,
          }),
        );
        steps.push(yield* read);
        const unknown = yield* servers.readSignInGeneration("0199e0e7-7b21-7000-8000-0000000000ff");
        return { steps, unknown };
      }).pipe(Effect.provide(TestDatabase), Effect.scoped, Effect.orDie),
    );

    expect(generations.steps).toEqual([0, 0, 1, 2, 3]);
    expect(Option.isNone(generations.unknown)).toBe(true);
  });

  it("marks a server signed in with OAuth, back to checking, with its revision raised", async () => {
    const server = await Effect.runPromise(
      Effect.gen(function* () {
        const servers = yield* arrange;
        yield* inTransaction(servers.update(URL_SERVER_ID, { status: "ready", checkedAt: AT }, AT));
        yield* inTransaction(servers.writeOAuthSignIn(URL_SERVER_ID, AT));
        return Option.getOrThrow(yield* servers.readById(URL_SERVER_ID));
      }).pipe(Effect.provide(TestDatabase), Effect.scoped, Effect.orDie),
    );

    expect(server).toMatchObject({ status: "checking", revision: 1, nextCheckAt: AT });
    expect(server.source).toMatchObject({ kind: "url", signIn: "oauth" });
  });
});
