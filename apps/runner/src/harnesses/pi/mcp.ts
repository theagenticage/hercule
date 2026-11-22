/**
 * How a pi process gets the session's MCP Gateway. pi has MCP and tool search
 * built in since 0.99, as extensions that pi bundles. Hercule starts pi with
 * `--no-extensions` so that only what it chose loads, and that flag drops the
 * bundled ones too, so the flags below name the two it wants.
 */
import { MCP_GATEWAY_ENTRY_NAME } from "@hercule/protocol";
import type { ResolvedMcpServer } from "../index";
import { MCP_GATEWAY_URL_VARIABLE } from "./extension";

/** What pi's command line and environment carry for MCP. */
interface McpLaunch {
  /** Flags to add to pi's command line. */
  readonly argv: ReadonlyArray<string>;
  /**
   * Variables to add to pi's environment. A value of `undefined` means the
   * variable must be removed: the runner may itself have been started inside a
   * pi session that set it.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Decides what one pi process gets for MCP, from the session's resolved MCP
 * servers, and returns the flags and the environment. Never fails.
 *
 * - With the MCP Gateway among the servers: the flags load pi's built-in MCP
 *   client and its tool search (`builtin:mcp` and `builtin:tool-search`), and
 *   the environment gives Hercule's extension the gateway's address. The
 *   extension registers the gateway with pi from it. `builtin:codemode` is left
 *   out: Hercule registers the gateway's tools as `deferred`, which the model
 *   finds with `tool_search`, so nothing needs pi's code-writing mode.
 * - Without it: no flags, and the address variable is removed, so the
 *   extension registers nothing.
 *
 * The session's token never travels here. The extension only names the
 * `HERCULE_TOKEN` variable, which pi reads itself when it connects, so the
 * token is in no argument (the process list shows those) and in no variable
 * this function sets. A server of another name is not the gateway and is
 * ignored: the controller only ever sends the gateway.
 */
export const decideMcpLaunch = (servers: ReadonlyArray<ResolvedMcpServer>): McpLaunch => {
  const gateway = servers.find((server) => server.name === MCP_GATEWAY_ENTRY_NAME);
  if (gateway === undefined) return { argv: [], env: { [MCP_GATEWAY_URL_VARIABLE]: undefined } };
  return {
    argv: ["-e", "builtin:mcp", "-e", "builtin:tool-search"],
    env: { [MCP_GATEWAY_URL_VARIABLE]: gateway.url },
  };
};
