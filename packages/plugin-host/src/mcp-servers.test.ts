import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  McpServerDeclaration,
  McpServerOrigin,
  McpServerName,
  type McpServerContribution,
} from "./mcp-servers";
import { PluginError, registerMcpServer } from "./plugin";

describe("McpServerName", () => {
  const isValid = Schema.is(McpServerName);

  it.each(["sentry", "a", "my_server2", "a_b_c", "a".repeat(16), "hercule_two"])(
    "accepts %s",
    (word) => {
      expect(isValid(word)).toBe(true);
    },
  );

  it.each([
    ["an empty string", ""],
    ["the reserved word", "hercule"],
    ["17 characters", "a".repeat(17)],
    ["a dash", "my-server"],
    ["a dot", "my.server"],
    ["a double underscore", "a__b"],
    ["a leading underscore", "_a"],
    ["a trailing underscore", "a_"],
    ["an uppercase letter", "Sentry"],
  ])("refuses %s", (_name, word) => {
    expect(isValid(word)).toBe(false);
  });
});

describe("McpServerOrigin", () => {
  const isValid = Schema.is(McpServerOrigin);

  it.each(["https://mcp.sentry.dev", "http://localhost:8080", "https://mcp.example.com:8443"])(
    "accepts %s",
    (origin) => {
      expect(isValid(origin)).toBe(true);
    },
  );

  it.each([
    ["a path", "https://mcp.sentry.dev/mcp"],
    ["a lone slash", "https://mcp.sentry.dev/"],
    ["a query", "https://mcp.sentry.dev?a=1"],
    ["a fragment", "https://mcp.sentry.dev#top"],
    ["a user name", "https://me@mcp.sentry.dev"],
    ["a user name and password", "https://me:secret@mcp.sentry.dev"],
    ["another scheme", "ftp://mcp.sentry.dev"],
    ["no scheme", "mcp.sentry.dev"],
    ["a default port written out", "https://mcp.sentry.dev:443"],
    ["an uppercase host", "https://MCP.sentry.dev"],
    ["nothing", ""],
  ])("refuses %s", (_name, origin) => {
    expect(isValid(origin)).toBe(false);
  });
});

describe("McpServerDeclaration", () => {
  const declaration = {
    id: "desk",
    displayName: "Desk",
    description: "One line.",
    connectionType: "acme/desk",
    origin: "https://mcp.desk.example",
  };
  const isValid = Schema.is(McpServerDeclaration);

  it("accepts a one-line description and refuses a description of more lines", () => {
    expect(isValid(declaration)).toBe(true);
    expect(isValid({ ...declaration, description: "First line.\nSecond line." })).toBe(false);
  });
});

describe("registerMcpServer", () => {
  const contribution: McpServerContribution = {
    id: "desk",
    displayName: "Desk",
    description: "Read Desk tickets.",
    connectionType: "acme/desk",
    origin: "https://mcp.desk.example",
    buildUpstreamRequest: () => ({ url: "https://mcp.desk.example/mcp", headers: {} }),
  };

  it("fails with a PluginError when the capability was not granted", async () => {
    const failure = await Effect.runPromise(Effect.flip(registerMcpServer({}, contribution)));

    expect(failure).toBeInstanceOf(PluginError);
    expect(failure.message).toBe("the mcp-servers capability was not granted");
  });
});
