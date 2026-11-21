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
