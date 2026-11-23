import { describe, expect, it } from "vitest";
import { splitGatewayToolName, splitPrefixedGatewayToolName } from "./gateway-tool-name";

// The cases of a normal name and of a tool name holding `__` are covered
// through the Claude Code and Codex item tests. These are the names the
// gateway never builds.
describe("splitGatewayToolName", () => {
  it.each(["__search_issues", "sentry__"])(
    "returns undefined for %j, which has an empty server part or tool part",
    (name) => {
      expect(splitGatewayToolName(name)).toBeUndefined();
    },
  );
});

describe("splitPrefixedGatewayToolName", () => {
  it("splits a gateway tool's prefixed name into its MCP Server and its tool", () => {
    expect(splitPrefixedGatewayToolName("mcp__tools__sentry__search_issues")).toEqual({
      server: "sentry",
      tool: "search_issues",
    });
  });

  it("returns undefined for the tool of another MCP server", () => {
    expect(splitPrefixedGatewayToolName("mcp__other__x")).toBeUndefined();
  });

  it("returns undefined for a gateway name with no server part or no tool part", () => {
    expect(splitPrefixedGatewayToolName("mcp__tools__")).toBeUndefined();
    expect(splitPrefixedGatewayToolName("mcp__tools__sentry")).toBeUndefined();
  });
});
