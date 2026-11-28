/**
 * The `instructions` the MCP Gateway sends with its first answer (spec 21
 * section 3.2). It is one line, because Codex shows the model that line and
 * no tool names.
 */

/** The longest instructions line, in characters. */
const MAX_INSTRUCTIONS_LENGTH = 250;

/** Why a session is served no tools, when it is served none. */
export type ServedNothingBecause = "missing-grant" | "no-servers";

/**
 * Builds the one-line instructions. With servers it names them in the order
 * given, cut at 250 characters with "...". With none it says why the list is
 * empty: the session's profile lacks `mcp.use`, or no server is in its list.
 */
export const buildInstructions = (
  serverNames: ReadonlyArray<string>,
  nothingBecause: ServedNothingBecause | undefined,
): string => {
  if (nothingBecause === "missing-grant") {
    return "No MCP tools are offered: this session's permission profile lacks the mcp.use grant.";
  }
  if (serverNames.length === 0) {
    return "No MCP tools are offered: no MCP server is in this session's list.";
  }
  const line = `MCP tools of these servers: ${serverNames.join(", ")}.`;
  return line.length <= MAX_INSTRUCTIONS_LENGTH
    ? line
    : `${line.slice(0, MAX_INSTRUCTIONS_LENGTH - 3)}...`;
};
