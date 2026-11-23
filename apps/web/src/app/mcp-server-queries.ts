import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { buildMcpListQuery, type McpServerQueries } from "@hercule/client-core/mcp-servers";
import { mcpServerQuery, mcpServersQuery } from "./queries";

/**
 * Returns how this app's query cache holds the MCP servers: the one definition
 * of the list's query and of a server's page query, which every module of
 * client-core that reads servers (the dialogs that write a server added by
 * URL, the switches) is given.
 */
export const buildMcpServerQueries = (
  queryClient: QueryClient,
  client: HerculeClient,
): McpServerQueries => ({
  readServers: () => queryClient.getQueryData(mcpServersQuery(client).queryKey)?.items,
  readCatalogue: () => buildMcpListQuery(queryClient, mcpServersQuery(client)),
  buildServerQuery: (mcpServerId) => {
    const { queryKey, queryFn } = mcpServerQuery(client, mcpServerId);
    // The page query's options type its read as optional, so it is passed on only when there is one.
    return { queryKey, ...(queryFn === undefined ? {} : { queryFn }) };
  },
});
