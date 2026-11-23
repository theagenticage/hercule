import type { JSX } from "react";
import {
  describeAgentToolsNote,
  describeUnavailableAgentToolsNote,
  type OfferedServer,
} from "@hercule/client-core/mcp-servers";
import { ChevronRightIcon } from "../../../icons/chevron-right";

/**
 * What a Connection row says about the MCP server its plugin offers (spec 17
 * §Settings, Connections): one small line under the account, that leads to
 * the server in Settings > MCP servers. It is no switch.
 */
export interface AgentTools {
  /** "agent tools off", "agent tools on", "agent tools: needs sign-in" or "agent tools: not available". */
  readonly text: string;
  /**
   * `fail` for a server that needs sign-in, is unreachable or is in error.
   * `unavailable` when the servers could not be read, so nothing is known.
   */
  readonly tone: "off" | "on" | "fail" | "unavailable";
  /** The server's id, which its page is addressed by, or `null` while the server has no record. */
  readonly serverId: string | null;
}

/**
 * Returns what the Connection of `offered` says about its server. The words
 * come from `describeAgentToolsNote`; the tone picks the mark in front of
 * them.
 */
export const describeAgentTools = ({ server }: OfferedServer): AgentTools => {
  const { words, failing } = describeAgentToolsNote(server);
  return {
    text: words,
    tone: failing ? "fail" : server?.enabled === true ? "on" : "off",
    serverId: server?.id ?? null,
  };
};

/**
 * Returns what each Connection with a server says about it, by the
 * Connection's id: one note for each server its plugins offer, in the order
 * of `offered`.
 */
export const mapAgentToolsByConnection = (
  offered: readonly OfferedServer[],
): ReadonlyMap<string, readonly AgentTools[]> => {
  const byConnection = new Map<string, AgentTools[]>();
  for (const each of offered) {
    byConnection.set(each.connection.id, [
      ...(byConnection.get(each.connection.id) ?? []),
      describeAgentTools(each),
    ]);
  }
  return byConnection;
};

/**
 * Returns the note of every Connection that has a server, for when the
 * servers could not be read: one note for the Connection, "agent tools: not
 * available", with no server to lead to. `offered` comes from a list with no
 * servers.
 */
export const mapUnavailableAgentTools = (
  offered: readonly OfferedServer[],
): ReadonlyMap<string, readonly AgentTools[]> =>
  new Map(
    offered.map(({ connection }) => [
      connection.id,
      [{ text: describeUnavailableAgentToolsNote().words, tone: "unavailable", serverId: null }],
    ]),
  );

/**
 * Renders the line of `tools` as a small button that calls `onOpen`. It
 * starts with a mark of the server's state: a ring while it is off, a filled
 * dot while it is on, and the app's red dot while it needs the user. A note
 * that says the servers are not available is plain text in the muted ink: there
 * is no server to open.
 */
export function AgentToolsButton({
  tools,
  onOpen,
}: {
  readonly tools: AgentTools;
  readonly onOpen: () => void;
}): JSX.Element {
  if (tools.tone === "unavailable") {
    return <span className="conn-tools is-unavailable">{tools.text}</span>;
  }
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
