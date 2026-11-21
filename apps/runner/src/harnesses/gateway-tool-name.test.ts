import { describe, expect, it } from "vitest";
import { splitGatewayToolName } from "./gateway-tool-name";

describe("splitGatewayToolName", () => {
  it("splits a gateway tool name into its MCP Server and its tool", () => {
    expect(splitGatewayToolName("sentry__search_issues")).toEqual({
      server: "sentry",
      tool: "search_issues",
    });
  });

  it("splits at the first double underscore, so a tool name holding one stays whole", () => {
    expect(splitGatewayToolName("sentry__search__issues")).toEqual({
      server: "sentry",
      tool: "search__issues",
    });
  });

  it.each(["search_issues", "__search_issues", "sentry__", ""])(
    "returns undefined for %j, which has no server part or no tool part",
    (name) => {
      expect(splitGatewayToolName(name)).toBeUndefined();
    },
  );
});
