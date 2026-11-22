import type { McpServer } from "@hercule/contract";
import type { McpServerDisplayStatus } from "./status";

/** Returns the status a screen shows for `server`: `off` when it is switched off, else its status. */
export const decideDisplayStatus = (server: McpServer): McpServerDisplayStatus =>
  server.enabled ? server.status : "off";
