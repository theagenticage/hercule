import { describe, expect, it } from "vitest";
import type { PluginDetail } from "@hercule/contract";
import { readMcpServerOffers } from "./offers";
import { LINEAR_PLUGIN, SENTRY_PLUGIN } from "./testing";

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
