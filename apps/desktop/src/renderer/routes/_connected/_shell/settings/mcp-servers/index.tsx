import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { buildMcpServerSettingsRows } from "@hercule/client-core/mcp-servers";
import { rememberSettingsSection } from "../../../../../app/last-settings-section";
import {
  connectionsQuery,
  mcpServersQuery,
  pluginsQuery,
  projectsQuery,
  readOnOpen,
  settingsQuery,
} from "../../../../../app/queries";
import {
  ConnectionServers,
  ServerList,
} from "../../../../../screens/settings/mcp-servers/server-list";
import { DefaultList } from "./-default-list";
import { ServerRow } from "./-server-row";

/**
 * Settings > MCP servers, the list (spec 17 §Settings, MCP servers): the
 * group "From your Connections", one switch for each Connection whose plugin
 * offers a server, and the group "Threads without a project", the default
 * list. Each row with a record leads to the server's page. The header has no
 * button.
 *
 * The section's layout holds the `mcpServer` topic, which keeps the list
 * current, so the loader reads it only when it is not cached yet; the
 * controller's first push on the topic reads it again. The projects, the
 * Connections and the plugins are the shell's reads. The default list is a
 * setting, read each time the section opens.
 */
export const Route = createFileRoute("/_connected/_shell/settings/mcp-servers/")({
  staticData: { title: "MCP servers" },
  loader: async ({ context: { controller, queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(mcpServersQuery(controller.client)),
      readOnOpen(queryClient, settingsQuery(controller.client)),
    ]);
  },
  onEnter: () => {
    rememberSettingsSection("/settings/mcp-servers");
  },
  component: McpServers,
});

function McpServers(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const servers = useSuspenseQuery(mcpServersQuery(client)).data;
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const rows = buildMcpServerSettingsRows({ servers, connections, plugins, projects });
  return (
    <ServerList>
      <ConnectionServers isEmpty={rows.length === 0}>
        {rows.map((row) => (
          <ServerRow key={`${row.offer.contributionId}:${row.connection.id}`} row={row} />
        ))}
      </ConnectionServers>
      <DefaultList />
    </ServerList>
  );
}
