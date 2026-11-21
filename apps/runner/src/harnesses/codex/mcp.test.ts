import { describe, expect, it } from "vitest";
import { buildMcpServerConfig } from "./mcp";

describe("buildMcpServerConfig", () => {
  const SENTRY = { name: "sentry", url: "http://127.0.0.1:7777/sentry" };
  const TOOLS = { name: "tools", url: "http://127.0.0.1:7777/mcp" };

  it("returns no key at all for a session with no MCP server", () => {
    expect(buildMcpServerConfig([], "prompt", true)).toEqual({});
  });

  it("gives each server its URL, the name of the token variable and the approval mode", () => {
    expect(buildMcpServerConfig([TOOLS, SENTRY], "approve", false)).toEqual({
      "mcp_servers.tools.url": TOOLS.url,
      "mcp_servers.tools.enabled": true,
      "mcp_servers.tools.disabled_tools": [],
      "mcp_servers.tools.bearer_token_env_var": "HERCULE_TOKEN",
      "mcp_servers.tools.default_tools_approval_mode": "approve",
      "mcp_servers.sentry.url": SENTRY.url,
      "mcp_servers.sentry.enabled": true,
      "mcp_servers.sentry.disabled_tools": [],
      "mcp_servers.sentry.bearer_token_env_var": "HERCULE_TOKEN",
      "mcp_servers.sentry.default_tools_approval_mode": "approve",
    });
  });

  it("sets the tool list feature once, only when asked", () => {
    expect(buildMcpServerConfig([TOOLS], "prompt", true)).toMatchObject({
      "features.mcp_tool_list_changed": true,
    });
    expect(buildMcpServerConfig([TOOLS], "prompt", false)).not.toHaveProperty(
      "features.mcp_tool_list_changed",
    );
  });
});
