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
  readServers: () => queryClient.getQueryData(mcpServersQuery(client).queryKey),
  readCatalogue: () => buildMcpListQuery(queryClient, mcpServersQuery(client)),
  readServerQuery: (mcpServerId) => {
    const { queryKey } = mcpServerQuery(client, mcpServerId);
    return { queryKey, queryFn: () => client.mcpServer.read({ params: { id: mcpServerId } }) };
  },
});
