import { describe, expect, it } from "vitest";
import { sentryMcpServer } from "./mcp-server";

const URL_WITH_QUERY = "https://mcp.sentry.dev/mcp?disable-skills=project-management";

describe("Sentry's MCP server request", () => {
  it.each([
    ["a pasted token", { token: "pasted" }, "pasted"],
    ["a device flow token", { accessToken: "device" }, "device"],
    ["both, preferring the device flow's", { accessToken: "device", token: "pasted" }, "device"],
  ])("sends %s as a Sentry-Bearer header", (_name, credentials, token) => {
    expect(sentryMcpServer.buildUpstreamRequest({ credentials, config: {} })).toEqual({
      url: URL_WITH_QUERY,
      headers: { Authorization: `Sentry-Bearer ${token}` },
    });
  });

  it("sends no Authorization header when the credentials hold no token, and does not throw", () => {
    expect(sentryMcpServer.buildUpstreamRequest({ credentials: {}, config: {} })).toEqual({
      url: URL_WITH_QUERY,
      headers: {},
    });
  });
});
