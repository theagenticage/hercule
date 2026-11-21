import type { JSX } from "react";
import {
  describeAgentToolsNote,
  type McpServerSettingsRow,
} from "@hercule/client-core/mcp-servers";
import { ChevronRightIcon } from "../../../icons/chevron-right";

/**
 * What a Connection row says about the MCP server its plugin offers (spec 17
 * §Settings, Connections): one small line under the account, that leads to
 * the server in Settings > MCP servers. It is no switch.
 */
export interface AgentTools {
  /** "agent tools off", "agent tools on" or "agent tools: needs sign-in". */
  readonly text: string;
  /** `fail` for a server that needs sign-in, is unreachable or is in error. */
  readonly tone: "off" | "on" | "fail";
  /** The server's id, which its page is addressed by, or `null` while the server has no record. */
  readonly serverId: string | null;
}

/**
 * Returns what the Connection of `row` says about its server. The words come
 * from `describeAgentToolsNote`; the tone picks the mark in front of them.
 */
export const describeAgentTools = (row: McpServerSettingsRow): AgentTools => {
  const { view } = row;
  const { words, failing } = describeAgentToolsNote(view);
  const switchedOn = view !== null && view.displayStatus !== "off";
  return {
    text: words,
    tone: failing ? "fail" : switchedOn ? "on" : "off",
    serverId: view?.server.id ?? null,
  };
};

/**
 * Returns what each Connection with a server says about it, by the
 * Connection's id. A Connection whose plugin offers two servers says what its
 * first row's server is doing.
 */
export const mapAgentToolsByConnection = (
  rows: readonly McpServerSettingsRow[],
): ReadonlyMap<string, AgentTools> => {
  const byConnection = new Map<string, AgentTools>();
  for (const row of rows) {
    if (!byConnection.has(row.connection.id)) {
      byConnection.set(row.connection.id, describeAgentTools(row));
    }
  }
  return byConnection;
};

/**
 * Renders the line of `tools` as a small button that calls `onOpen`. It
 * starts with a mark of the server's state: a ring while it is off, a filled
 * dot while it is on, and the app's red dot while it needs the user.
 */
export function AgentToolsButton({
  tools,
  onOpen,
}: {
  readonly tools: AgentTools;
  readonly onOpen: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`conn-tools is-${tools.tone}`}
      title="Agent tools are switched on and off in Settings > MCP servers"
      onClick={onOpen}
    >
      <i className={tools.tone === "fail" ? "dot dot--fail" : "dot"} />
      {tools.text}
      <ChevronRightIcon size={10} />
    </button>
  );
}
