import { MCP_GATEWAY_HARNESS_PREFIX, MCP_GATEWAY_TOOL_SEPARATOR } from "@hercule/protocol";

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
  const split = name.indexOf(MCP_GATEWAY_TOOL_SEPARATOR);
  const toolStart = split + MCP_GATEWAY_TOOL_SEPARATOR.length;
  if (split <= 0 || toolStart >= name.length) return undefined;
  return { server: name.slice(0, split), tool: name.slice(toolStart) };
};

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
  name.startsWith(MCP_GATEWAY_HARNESS_PREFIX)
    ? splitGatewayToolName(name.slice(MCP_GATEWAY_HARNESS_PREFIX.length))
    : undefined;
