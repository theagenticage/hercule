import type { JSX } from "react";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { MCP_SERVER_TOPICS, useScreenTopicsLive } from "../../../../../app/live";

/**
 * Settings > MCP servers, around both the list and a server's page: holds
 * the `mcpServer` topic while either is open, so a check that ends, a server
 * switched off from the CLI, or one deleted elsewhere shows at once. The
 * topic is held here rather than by each screen, so going from the list to a
 * page keeps the one subscription instead of dropping it and subscribing
 * again.
 */
export const Route = createFileRoute("/_connected/_shell/settings/mcp-servers")({
  component: McpServersLayout,
});

function McpServersLayout(): JSX.Element {
  const { controller, queryClient } = Route.useRouteContext();
  useScreenTopicsLive(controller.live, queryClient, MCP_SERVER_TOPICS);
  return <Outlet />;
}
