import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { buildMcpServerViews, type McpServerView } from "@hercule/client-core/mcp-servers";
import { connectionsQuery, mcpServersQuery, pluginsQuery } from "../app/queries";

/** The views of the MCP Servers, and why they could not be read. */
export interface McpServerViews {
  /** Every MCP Server joined with its Connection and plugin, or `undefined` until all three have been read. */
  readonly views: McpServerView[] | undefined;
  /** The error of a read that failed, or `null`. */
  readonly failure: Error | null;
}

/**
 * Returns the views of every MCP Server, joined with their Connections and
 * the plugins that offer them.
 *
 * The reads are `enabled` only while the caller needs them. A disabled read
 * still returns what the cache already holds, so a caller that stopped
 * needing the servers keeps drawing the last answer. Reading happens once
 * when `enabled` turns true and the cache is empty or stale.
 *
 * Whoever calls this also subscribes to the live topic `mcpServer` while it
 * needs the views (`useLiveInvalidation`), so a status that changes elsewhere
 * reaches the screen.
 */
export const useMcpServerViews = (client: HerculeClient, enabled: boolean): McpServerViews => {
  const servers = useQuery({ ...mcpServersQuery(client), enabled });
  const connections = useQuery({ ...connectionsQuery(client), enabled });
  const plugins = useQuery({ ...pluginsQuery(client), enabled });
  const views = useMemo(
    () =>
      servers.data === undefined || connections.data === undefined || plugins.data === undefined
        ? undefined
        : buildMcpServerViews(servers.data.items, connections.data.items, plugins.data),
    [servers.data, connections.data, plugins.data],
  );
  return { views, failure: servers.error ?? connections.error ?? plugins.error };
};
