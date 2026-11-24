/**
 * Tests what the Slack plugin adds to the catalog: the capabilities it asks
 * for, and the connection type and MCP server it registers.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type {
  ConnectionTypeContribution,
  McpServerContribution,
  RegistrationHost,
} from "@hercule/plugin-host";
import { slack } from "./index";

/** Runs `register` and returns everything the plugin contributed. */
const collectContributions = async () => {
  const types: Array<ConnectionTypeContribution> = [];
  const mcpServers: Array<McpServerContribution> = [];
  const host: RegistrationHost = {
    connections: {
      registerType: (contribution) => Effect.sync(() => void types.push(contribution)),
    },
    eventSources: { register: () => Effect.die("the plugin registers no event sources") },
    workflowActions: { register: () => Effect.die("the plugin registers no workflow actions") },
    mcpServers: {
      register: (contribution) => Effect.sync(() => void mcpServers.push(contribution)),
    },
  };
  await Effect.runPromise(slack.register(host));
  return { types, mcpServers };
};

describe("what the slack plugin registers", () => {
  it("requests the capabilities its connection type and MCP server use", () => {
    expect(slack.manifest).toMatchObject({
      id: "slack",
      displayName: "Slack",
      capabilities: ["connections", "mcp-servers"],
    });
    expect(slack.manifest.mark?.paths).toHaveLength(1);
  });

  it("contributes one type with a redirect flow through an app created at setup", async () => {
    const { types } = await collectContributions();

    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({
      type: "slack",
      displayName: "Slack",
      setup: [expect.objectContaining({ kind: "checklist" }), { kind: "oauth" }],
      oauth: {
        authorizationUrl: "https://slack.com/oauth/v2_user/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.user.access",
        resource: "https://mcp.slack.com",
        transientErrors: [
          "internal_error",
          "service_unavailable",
          "fatal_error",
          "request_timeout",
          "ratelimited",
        ],
        publicClient: {
          createdAtSetup: {
            fields: [{ name: "configurationToken", secret: true }],
          },
          redirectUris: [
            "http://127.0.0.1/oauth/callback",
            "http://localhost/oauth/callback",
            "http://127.0.0.1/callback",
          ],
        },
      },
    });
    expect(types[0]?.createOAuthClient).toBeDefined();
  });

  it("contributes one MCP server for its own connection type", async () => {
    const { mcpServers } = await collectContributions();

    expect(mcpServers.map((server) => [server.id, server.connectionType])).toEqual([
      ["slack", "slack/slack"],
    ]);
  });
});
