import { describe, expect, it } from "vitest";
import { slackMcpServer } from "./mcp-server";

describe("Slack's MCP server request", () => {
  it("sends the access token as a Bearer header", () => {
    expect(
      slackMcpServer.buildUpstreamRequest({ credentials: { accessToken: "xoxp-1" }, config: {} }),
    ).toEqual({
      url: "https://mcp.slack.com/mcp",
      headers: { Authorization: "Bearer xoxp-1" },
    });
  });

  it("sends no Authorization header when the credentials hold no token, and does not throw", () => {
    expect(slackMcpServer.buildUpstreamRequest({ credentials: {}, config: {} })).toEqual({
      url: "https://mcp.slack.com/mcp",
      headers: {},
    });
  });
});

describe("Slack's MCP server contribution", () => {
  it("is added with the Connection, because a Slack Connection exists to reach it", () => {
    expect(slackMcpServer.addWhenConnected).toBe(true);
  });
});
