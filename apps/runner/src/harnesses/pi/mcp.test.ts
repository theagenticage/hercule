/**
 * Tests what a pi process is given for MCP, from the session's resolved MCP
 * servers.
 */
import { describe, expect, it } from "vitest";
import { MCP_GATEWAY_ENTRY_NAME } from "@hercule/protocol";
import { SESSION_TOKEN_VARIABLE } from "../../credentials/helper";
import { MCP_GATEWAY_URL_VARIABLE } from "./extension";
import { decideMcpLaunch } from "./mcp";

const GATEWAY_URL = "http://127.0.0.1:7421/mcp";

describe("what a pi process gets for MCP", () => {
  it("loads pi's MCP client and tool search, and gives the extension the gateway's address", () => {
    const launch = decideMcpLaunch([{ name: MCP_GATEWAY_ENTRY_NAME, url: GATEWAY_URL }]);

    // Not `builtin:codemode`: the gateway's tools are found with `tool_search`.
    expect(launch.argv).toEqual(["-e", "builtin:mcp", "-e", "builtin:tool-search"]);
    expect(launch.env).toEqual({ [MCP_GATEWAY_URL_VARIABLE]: GATEWAY_URL });
  });

  it("carries no token, and not even the name of the variable that holds it", () => {
    const launch = decideMcpLaunch([{ name: MCP_GATEWAY_ENTRY_NAME, url: GATEWAY_URL }]);

    const everything = JSON.stringify(launch);
    expect(everything).not.toContain(SESSION_TOKEN_VARIABLE);
    expect(everything).not.toContain("Bearer");
  });

  it("loads nothing and removes an inherited address when the session has no servers", () => {
    const launch = decideMcpLaunch([]);

    expect(launch.argv).toEqual([]);
    // `undefined` is how the adapter asks for a variable to be removed, in case
    // the runner was started inside a pi session that had the gateway.
    expect(launch.env).toHaveProperty(MCP_GATEWAY_URL_VARIABLE, undefined);
  });

  it("treats a server of another name as no gateway", () => {
    const launch = decideMcpLaunch([{ name: "jira", url: "http://127.0.0.1:9/mcp" }]);

    expect(launch.argv).toEqual([]);
    expect(launch.env).toHaveProperty(MCP_GATEWAY_URL_VARIABLE, undefined);
  });
});
