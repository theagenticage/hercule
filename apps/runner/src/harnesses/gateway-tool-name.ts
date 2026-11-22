import { MCP_GATEWAY_ENTRY_NAME } from "@hercule/protocol";

/**
 * Splits the name of a tool of the MCP Gateway into the MCP Server it belongs
 * to and the tool's own name: `sentry__search_issues` gives the server
 * `sentry` and the tool `search_issues`. The gateway builds every tool name as
 * `<server>__<tool>`, and each harness then shows it under its own prefix, so
 * this works on the name without that prefix.
 *
 * The split is at the first `__`, so a tool name that holds `__` stays whole.
 * Returns `undefined` for a name with no server part or no tool part, which the
 * gateway never builds.
 */
export const splitGatewayToolName = (
  name: string,
): { readonly server: string; readonly tool: string } | undefined => {
  const split = name.indexOf("__");
  if (split <= 0 || split + 2 >= name.length) return undefined;
  return { server: name.slice(0, split), tool: name.slice(split + 2) };
};

/** What Claude Code and pi put in front of the name of every tool of the MCP Gateway's entry, `tools`. */
const GATEWAY_TOOL_PREFIX = `mcp__${MCP_GATEWAY_ENTRY_NAME}__`;

/**
 * Splits the name of a gateway tool, as a harness that prefixes MCP tool names
 * shows it, into the MCP Server it belongs to and the tool's own name:
 * `mcp__tools__sentry__search_issues` gives the server `sentry` and the tool
 * `search_issues`. Claude Code and pi both build that name from the gateway's
 * entry name and the gateway's own tool name. Returns `undefined` for any
 * other tool, and for a name with no server part, which the gateway never
 * builds.
 */
export const splitPrefixedGatewayToolName = (
  name: string,
): { readonly server: string; readonly tool: string } | undefined =>
  name.startsWith(GATEWAY_TOOL_PREFIX)
    ? splitGatewayToolName(name.slice(GATEWAY_TOOL_PREFIX.length))
    : undefined;
