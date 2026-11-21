/**
 * The words and the red dot the composer's `+` shows for a Thread's MCP
 * servers. Kept apart from the rest of the thread menu because the first
 * screen draws the `+` before the menu's code has loaded, and this file
 * imports nothing but the display status (`display-status.ts`).
 */
import type { McpServer } from "@hercule/contract";
import { decideDisplayStatus } from "./display-status";

/**
 * Returns how many of the Thread's servers need sign-in, for the "1 needs
 * sign-in" on the menu's row and the red dot on the `+`. A server that is
 * switched off in Settings does not count: it reads "off".
 */
export const countServersNeedingSignIn = (
  servers: readonly McpServer[],
  mcpServerIds: readonly string[],
): number =>
  servers.filter(
    (server) => mcpServerIds.includes(server.id) && decideDisplayStatus(server) === "needs-sign-in",
  ).length;

/** The words on the `+` menu's "MCP servers" row. */
export interface ThreadServersRow {
  /** "none", a count such as "3", or "1 needs sign-in" / "2 need sign-in". */
  readonly words: string;
  /** Whether `words` says a server needs sign-in, so the row draws them in the failure colour. */
  readonly failing: boolean;
}

/**
 * Returns the words for the "MCP servers" row of the `+` menu: "none" for an
 * empty list, the number of servers otherwise, and "1 needs sign-in" or "2
 * need sign-in" while a server of the Thread's list needs sign-in
 * (`countServersNeedingSignIn`). Pass no servers while they are not read
 * yet: the row then shows the count, and the words change once they are. It
 * takes the server records rather than their views, so the first screen can
 * draw the `+` without the code that joins servers with their Connections.
 */
export const describeThreadServersRow = (
  servers: readonly McpServer[],
  mcpServerIds: readonly string[],
): ThreadServersRow => {
  const needSignIn = countServersNeedingSignIn(servers, mcpServerIds);
  if (needSignIn > 0) {
    return {
      words: `${String(needSignIn)} ${needSignIn === 1 ? "needs" : "need"} sign-in`,
      failing: true,
    };
  }
  return {
    words: mcpServerIds.length === 0 ? "none" : String(mcpServerIds.length),
    failing: false,
  };
};
