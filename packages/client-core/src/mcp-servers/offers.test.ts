import { describe, expect, it } from "vitest";
import type { PluginDetail } from "@hercule/contract";
import { describeOfferAddress, joinOfferedServers, readMcpServerOffers } from "./offers";
import {
  CONNECTIONS,
  LINEAR_PLUGIN,
  OFFERING_PLUGINS,
  SENTRY_HOBBY,
  SENTRY_PLUGIN,
  buildConnection,
  buildServer,
} from "./testing";

describe("readMcpServerOffers", () => {
  it("returns one offer for each mcp-server contribution, named by its bare word, and ignores other contributions", () => {
    expect(readMcpServerOffers([SENTRY_PLUGIN, LINEAR_PLUGIN])).toEqual([
      {
        contributionId: "sentry/sentry",
        pluginId: "sentry",
        displayName: "Sentry",
        description: "The Sentry MCP server.",
        connectionType: "sentry/sentry",
        origin: "https://mcp.sentry.example",
        defaultName: "sentry",
      },
      expect.objectContaining({ contributionId: "linear/linear", defaultName: "linear" }),
    ]);
  });

  it("leaves out a contribution whose definition is missing a field", () => {
    const broken: PluginDetail = {
      ...SENTRY_PLUGIN,
      contributions: [
        { extensionPoint: "mcp-server", id: "sentry/broken", definition: { displayName: "x" } },
        { extensionPoint: "mcp-server", id: "sentry/text", definition: "not an object" },
      ],
    };

    expect(readMcpServerOffers([broken])).toEqual([]);
  });
});

describe("joinOfferedServers", () => {
  it("lists each offer on each Connection of its type, with the record that names both, or none", () => {
    const joined = joinOfferedServers({
      servers: [SENTRY_HOBBY],
      connections: CONNECTIONS,
      plugins: OFFERING_PLUGINS,
    });

    expect(
      joined.map(({ offer, connection, server }) => [
        offer.contributionId,
        connection.id,
        server?.id ?? null,
      ]),
    ).toEqual([
      ["sentry/sentry", "c-work", null],
      ["sentry/sentry", "c-hobby", "s-hobby"],
      ["linear/linear", "c-linear", null],
    ]);
  });

  it("does not match a record of another contribution on the same Connection, or a server added by URL", () => {
    const joined = joinOfferedServers({
      servers: [
        buildServer("s-other", "other", "c-work"),
        buildServer("s-url", "docs", "c-work", {
          source: {
            kind: "url",
            url: "https://docs.example/mcp",
            signIn: "none",
            signInOffered: null,
          },
        }),
      ],
      connections: [buildConnection("c-work", "sentry/sentry", "work")],
      plugins: [SENTRY_PLUGIN],
    });

    expect(joined.map(({ server }) => server)).toEqual([null]);
  });

  it("lists nothing for a Connection whose type no plugin offers a server for", () => {
    expect(
      joinOfferedServers({
        servers: [],
        connections: [buildConnection("c-x", "github/github", "x")],
        plugins: OFFERING_PLUGINS,
      }),
    ).toEqual([]);
  });
});

describe("describeOfferAddress", () => {
  it.each([
    ["https://mcp.sentry.dev", "mcp.sentry.dev"],
    ["https://mcp.example.com:8443", "mcp.example.com:8443"],
    ["http://localhost:3000", "localhost:3000"],
  ])("writes the origin %s as %s", (origin, address) => {
    expect(describeOfferAddress(origin)).toBe(address);
  });
});
