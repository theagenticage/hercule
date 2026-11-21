import type { JSX } from "react";
import { useMcpServerViews } from "../../app/mcp-server-views";

/**
 * Draws nothing, and keeps the MCP servers read and the `mcpServer` topic held
 * while it is mounted. A thread's page mounts it while the thread has a
 * server or a line about one, so the composer's row and the lines draw from
 * the cache. Loaded the first time such a thread opens (see
 * `lazy-thread-servers.ts`).
 */
export default function HoldMcpServers(): JSX.Element | null {
  useMcpServerViews("read");
  return null;
}
