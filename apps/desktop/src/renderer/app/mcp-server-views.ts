/**
 * Reads of the MCP servers for the screens of a thread and its composer: the
 * servers joined with their Connections, held only while a thread has a reason
 * to draw them.
 */
import { useMemo } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import { buildMcpServerViews, type McpServerView } from "@hercule/client-core/mcp-servers";
import type { MutableLiveTopic } from "@hercule/contract";
import { MCP_SERVER_TOPICS, useScreenTopicsLive } from "./live";
import { connectionsQuery, mcpServersQuery, pluginsQuery } from "./queries";

const NO_TOPICS: readonly MutableLiveTopic[] = [];

/**
 * How `useMcpServerViews` gets the servers:
 *
 * - `read`: from the cache, and from the controller when the cache holds none,
 *   with the `mcpServer` topic held while the caller is mounted;
 * - `cache`: only what the cache holds, never a read and never a topic;
 * - `off`: nothing, and no views are built.
 */
export type McpServerReadMode = "read" | "cache" | "off";

/** What `useMcpServerViews` returns. */
export interface McpServerViews {
  /** The servers joined with their Connections, or `undefined` until they are read, and in mode `off`. */
  readonly views: readonly McpServerView[] | undefined;
  /** Why the read failed, such as a token without `mcp.read`, or `null`. */
  readonly failure: string | null;
}

/**
 * Returns the views of every MCP server, as `mode` says. A thread with no
 * server and no line about servers reads nothing: its callers pass `off`.
 */
export function useMcpServerViews(mode: McpServerReadMode): McpServerViews {
  const { client, live } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  useScreenTopicsLive(live, queryClient, mode === "read" ? MCP_SERVER_TOPICS : NO_TOPICS);
  const servers = useQuery({ ...mcpServersQuery(client), enabled: mode === "read" });
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const views = useMemo(
    () =>
      mode === "off" || servers.data === undefined
        ? undefined
        : buildMcpServerViews(servers.data, connections, plugins),
    [mode, servers.data, connections, plugins],
  );
  return { views, failure: servers.error === null ? null : readErrorMessage(servers.error) };
}
