import type { McpServer } from "@hercule/contract";
import type { McpServerDisplayStatus } from "./status";

/** Returns the status a screen shows for `server`: `off` when it is switched off, else its status. */
export const decideDisplayStatus = (server: McpServer): McpServerDisplayStatus =>
  server.enabled ? server.status : "off";

/**
 * Checks whether the user must sign in to `server` again: it is switched on
 * and its status is `needs-sign-in`. It agrees with the `needsSignIn` fact of
 * `MCP_SERVER_STATUS_FACTS` for the status `decideDisplayStatus` returns; the
 * composer's `+` row calls this instead, so the first screen does not load
 * the table of facts.
 */
export const needsSignIn = (server: McpServer): boolean =>
  server.enabled && server.status === "needs-sign-in";
