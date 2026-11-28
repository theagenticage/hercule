/** Tests the one-line instructions the gateway sends (spec 21 section 3.2). */
import { describe, expect, it } from "vitest";
import { buildInstructions } from "./instructions";

describe("buildInstructions", () => {
  it("names the servers in the order given", () => {
    expect(buildInstructions(["linear", "sentry"], undefined)).toBe(
      "MCP tools of these servers: linear, sentry.",
    );
  });

  it("is one line of at most 250 characters, cut with an ellipsis", () => {
    const names = Array.from({ length: 40 }, (_, index) => `server_${index}`);
    const line = buildInstructions(names, undefined);
    expect(line.length).toBe(250);
    expect(line.endsWith("...")).toBe(true);
    expect(line).not.toContain("\n");
  });

  it("says why the list is empty", () => {
    expect(buildInstructions([], "missing-grant")).toContain("mcp.use");
    expect(buildInstructions([], undefined)).toContain("no MCP server is in this session's list");
  });
});
