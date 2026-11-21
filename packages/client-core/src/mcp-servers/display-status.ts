import type { McpServer } from "@hercule/contract";

/**
 * What a screen shows as a server's status. It is the record's `status`, but
 * `off` comes first: a server whose `enabled` is false reads "off" whatever
 * its status was when the user switched it off.
 */
export type McpServerDisplayStatus =
  | "ready"
  | "checking"
  | "needs-sign-in"
  | "unreachable"
  | "error"
  | "off";

/** Returns the status a screen shows for `server`. */
export const decideDisplayStatus = (server: McpServer): McpServerDisplayStatus =>
  server.enabled ? server.status : "off";
