import { describe, expect, it } from "vitest";
import { linearMcpServer } from "./mcp-server";

const MCP_URL = "https://mcp.linear.app/mcp";

describe("Linear's MCP server request", () => {
  it.each([
    ["a redirect flow token", { accessToken: "oauth" }, "oauth"],
    ["a pasted API key", { apiKey: "pasted" }, "pasted"],
    ["both, preferring the redirect flow's", { accessToken: "oauth", apiKey: "pasted" }, "oauth"],
  ])("sends %s as a Bearer header", (_name, credentials, token) => {
    expect(linearMcpServer.buildUpstreamRequest({ credentials, config: {} })).toEqual({
      url: MCP_URL,
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  it("sends no Authorization header when the credentials hold no token, and does not throw", () => {
    expect(linearMcpServer.buildUpstreamRequest({ credentials: {}, config: {} })).toEqual({
      url: MCP_URL,
      headers: {},
    });
  });
});
