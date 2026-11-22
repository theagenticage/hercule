/**
 * The words of the "agent tools" note a Connection row shows when its plugin
 * offers an MCP Server (spec 17, Settings > Connections). The web app and the
 * desktop app both draw it, so the words are decided here.
 */
import type { McpServer } from "@hercule/contract";
import { decideDisplayStatus } from "./display-status";
import { MCP_SERVER_STATUS_FACTS } from "./status";

/** What the note says, and whether it is drawn in the failure colours. */
export interface AgentToolsNote {
  /** Such as "agent tools off" or "agent tools: needs sign-in". */
  readonly words: string;
  /** Whether the server needs the user: it needs sign-in, is unreachable or is in error. */
  readonly failing: boolean;
}

/**
 * Returns the note a Connection shows when the servers could not be read and
 * none are cached: "agent tools: not available", muted, not failing. It
 * leads nowhere, because there is no server to open.
 */
export const describeUnavailableAgentToolsNote = (): AgentToolsNote => ({
  words: "agent tools: not available",
  failing: false,
});

/**
 * Returns the note for the `server` of a Connection, or for `null` while the
 * Connection's server has no record:
 *
 * - "agent tools off" with no record, and for a server switched off;
 * - "agent tools on" for a ready server;
 * - "agent tools: checking" while the server is being checked;
 * - "agent tools: needs sign-in", "agent tools: unreachable" or "agent tools:
 *   error", with `failing` true, for a server that needs the user.
 */
export const describeAgentToolsNote = (server: McpServer | null): AgentToolsNote => {
  const status = server === null ? "off" : decideDisplayStatus(server);
  if (status === "off") return { words: "agent tools off", failing: false };
  if (status === "ready") return { words: "agent tools on", failing: false };
  const { word, failing } = MCP_SERVER_STATUS_FACTS[status];
  return { words: `agent tools: ${word}`, failing };
};
