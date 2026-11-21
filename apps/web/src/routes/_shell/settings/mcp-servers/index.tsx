import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Group, LaneLabel } from "@hercule/ui";
import { buildMcpServerSettingsRows } from "@hercule/client-core/mcp-servers";
import { useLiveInvalidation } from "../../../../app/live-invalidation";
import {
  connectionsQuery,
  mcpServersQuery,
  pluginsQuery,
  projectsQuery,
  settingsQuery,
} from "../../../../app/queries";
import { DefaultList } from "./-default-list";
import { ServerRow } from "./-server-row";

export const Route = createFileRoute("/_shell/settings/mcp-servers/")({
  staticData: { title: "MCP servers" },
  // Settings change without a push (a command line, another window), so the
  // section reads them again each time it opens. A change made while it was
  // closed would otherwise stay hidden, and the next edit of the default list
  // would undo it.
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.fetchQuery({ ...settingsQuery(context.client), staleTime: 0 }),
      context.queryClient.ensureQueryData(mcpServersQuery(context.client)),
      context.queryClient.ensureQueryData(connectionsQuery(context.client)),
      context.queryClient.ensureQueryData(pluginsQuery(context.client)),
      context.queryClient.ensureQueryData(projectsQuery(context.client)),
    ]);
  },
  component: McpServers,
});

/**
 * The MCP servers screen: one row for every Connection whose plugin offers a
 * server, each with a switch, then the default list a thread in no project
 * starts with.
 *
 * The screen holds the `mcpServer` live topic while it is open, so a status
 * the controller changes (a check ended, a sign-in expired) shows at once.
 * Servers added by URL are not offered yet, so there is no such group.
 */
function McpServers(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();

  useLiveInvalidation(live, queryClient, "mcpServer");

  const servers = useSuspenseQuery(mcpServersQuery(client)).data.items;
  const connections = useSuspenseQuery(connectionsQuery(client)).data.items;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data.items;
  const rows = buildMcpServerSettingsRows({ servers, connections, plugins, projects });

  return (
    <div className="flex flex-col gap-7">
      <p className="max-w-[568px] text-row text-muted">
        An MCP server gives agents tools from another service. Set one up here once and every runner
        has it: the sign-in stays on the controller. A project names the servers its threads start
        with.
      </p>

      <section>
        <LaneLabel>
          From your Connections
          <span className="ml-2.5 font-normal tracking-normal text-faint normal-case">
            No second sign-in: the server is reached with the Connection
          </span>
        </LaneLabel>
        {rows.length === 0 ? (
          <p className="text-fine text-faint">
            No Connection offers a server yet. Connect an account whose plugin does, and its server
            shows here.
          </p>
        ) : (
          <Group>
            <ul className="flex flex-col">
              {rows.map((row) => (
                <ServerRow
                  key={`${row.offer.contributionId}:${row.connection.id}`}
                  client={client}
                  row={row}
                  plugins={plugins}
                />
              ))}
            </ul>
          </Group>
        )}
      </section>

      <DefaultList client={client} />
    </div>
  );
}
