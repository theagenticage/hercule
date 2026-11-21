import { useState, type JSX } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import {
  buildMcpServerViews,
  buildProjectBoxes,
  chooseNamedServer,
  type McpServerView,
  type ProjectBox,
} from "@hercule/client-core/mcp-servers";
import {
  connectionsQuery,
  mcpServersQuery,
  pluginsQuery,
  projectsQuery,
  settingsQuery,
} from "../../../../../app/queries";
import {
  ProjectBoxRow,
  ProjectsSection,
} from "../../../../../screens/settings/mcp-servers/server-projects";
import { readServersAgain } from "./-keep-server";

/**
 * Writes the list of `box`'s target so that it holds `serverId` in place of
 * every server of the page's name, or none of them with `null`. The list is
 * the one in the cache when the write starts, never the one the box was drawn
 * from, so a list another write changed meanwhile is not put back.
 *
 * Resolves when the controller has stored the list and the cache holds it.
 * Fails with the controller's refusal, or when the project was deleted.
 */
const writeBoxList = async (
  queryClient: QueryClient,
  client: HerculeClient,
  box: ProjectBox,
  view: McpServerView,
  serverId: string | null,
): Promise<void> => {
  const [servers, connections, plugins] = await Promise.all([
    queryClient.ensureQueryData(mcpServersQuery(client)),
    queryClient.ensureQueryData(connectionsQuery(client)),
    queryClient.ensureQueryData(pluginsQuery(client)),
  ]);
  const views = buildMcpServerViews(servers, connections, plugins);
  const { target } = box;
  if (target.kind === "default") {
    const settings = await queryClient.ensureQueryData(settingsQuery(client));
    const ids = chooseNamedServer(
      settings.user["thread.mcpServerIds"] ?? [],
      views,
      view.server.name,
      serverId,
    );
    const saved = await client.settings.update({
      payload: { user: { "thread.mcpServerIds": ids } },
    });
    queryClient.setQueryData(settingsQuery(client).queryKey, saved);
    return;
  }
  const projects = await queryClient.ensureQueryData(projectsQuery(client));
  const project = projects.find((each) => each.id === target.project.id);
  if (project === undefined) {
    throw new Error(`${target.project.name} no longer exists, so its list was not changed.`);
  }
  const ids = chooseNamedServer(project.mcpServerIds, views, view.server.name, serverId);
  const saved = await client.project.update({
    params: { id: project.id },
    payload: { mcpServerIds: ids },
  });
  queryClient.setQueryData(projectsQuery(client).queryKey, (current) =>
    current?.map((each) => (each.id === saved.id ? saved : each)),
  );
};

/**
 * Renders the Projects section of the page of the server `view` (spec 17
 * §Settings, MCP servers): one box for each project and one for the threads
 * without a project. It reads the projects, the default list and the other
 * servers, because whether a box can be ticked depends on the other server of
 * the same name that its list may already name.
 */
export function ProjectBoxes({ view }: { readonly view: McpServerView }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const servers = useSuspenseQuery(mcpServersQuery(client)).data;
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const views = buildMcpServerViews(servers, connections, plugins);
  const boxes = buildProjectBoxes(
    view,
    views,
    projects,
    settings.user["thread.mcpServerIds"] ?? [],
  );
  return (
    <ProjectsSection boxes={boxes}>
      {boxes.map((box) => (
        <ProjectBoxItem
          key={box.target.kind === "project" ? box.target.project.id : "default"}
          box={box}
          view={view}
        />
      ))}
    </ProjectsSection>
  );
}

/**
 * Renders one box and owns its write. One list write runs at a time for a
 * box: while it runs the box ignores presses, and it counts as running until
 * the list is read again. A refusal shows under the box.
 *
 * Pressing a box that is free ticks it, and pressing a ticked box unticks it.
 * Pressing a box whose list names another server of the same name writes
 * nothing and shows the refusal; "Use ..." then writes the swap as one
 * change, and "Keep ..." closes the refusal.
 */
function ProjectBoxItem({
  box,
  view,
}: {
  readonly box: ProjectBox;
  readonly view: McpServerView;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const [refusing, setRefusing] = useState(false);
  const write = useMutation({
    mutationFn: (serverId: string | null) => writeBoxList(queryClient, client, box, view, serverId),
    onSuccess: () => {
      setRefusing(false);
    },
    onSettled: async () => {
      await readServersAgain(queryClient, client, view.server.id, [
        box.target.kind === "default"
          ? settingsQuery(client).queryKey
          : projectsQuery(client).queryKey,
      ]);
    },
  });
  return (
    <ProjectBoxRow
      box={box}
      view={view}
      allProjects={projects}
      refusing={refusing}
      busy={write.isPending}
      error={write.error === null ? null : `Could not save: ${readErrorMessage(write.error)}`}
      onTick={(ticked) => {
        if (ticked && box.takenBy !== null) {
          setRefusing(true);
          return;
        }
        write.mutate(ticked ? view.server.id : null);
      }}
      onUse={() => {
        write.mutate(view.server.id);
      }}
      onKeep={() => {
        setRefusing(false);
      }}
    />
  );
}
