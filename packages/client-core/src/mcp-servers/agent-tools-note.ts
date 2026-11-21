/**
 * The words of the "agent tools" note a Connection row shows when its plugin
 * offers an MCP Server (spec 17, Settings > Connections). The web app and the
 * desktop app both draw it, so the words are decided here.
 */
import type { McpServerView } from "./views";

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
 * Returns the note for the server `view` of a Connection, or for `null`
 * while the Connection's server has no record:
 *
 * - "agent tools off" with no record, and for a server switched off;
 * - "agent tools on" for a ready server;
 * - "agent tools: checking" while the server is being checked;
 * - "agent tools: needs sign-in", "agent tools: unreachable" or "agent tools:
 *   error", with `failing` true, for a server that needs the user.
 */
export const describeAgentToolsNote = (view: McpServerView | null): AgentToolsNote => {
  if (view === null || view.displayStatus === "off") {
    return { words: "agent tools off", failing: false };
  }
  if (view.displayStatus === "ready") return { words: "agent tools on", failing: false };
  return { words: `agent tools: ${view.statusWord}`, failing: view.failing };
};
