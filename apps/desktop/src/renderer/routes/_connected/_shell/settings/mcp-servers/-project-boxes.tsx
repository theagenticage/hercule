import { useState, type JSX } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { isMutationRunning } from "@hercule/client-core";
import {
  buildMcpServerViews,
  buildProjectBoxes,
  decideProjectBoxWrite,
  type McpServerView,
  type ProjectBox,
  type ProjectBoxAction,
} from "@hercule/client-core/mcp-servers";
import { readCachedMcpServerViews } from "../../../../../app/mcp-server-views";
import { mcpWriteKeys, useMcpWrite } from "../../../../../app/mcp-write";
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
 * Renders one box and owns its write. One list write runs at a time for the
 * box's list, wherever it was started from, and counts as running until the
 * list is read again; while it runs the box ignores presses. A refusal shows
 * under the box.
 *
 * What a press writes is decided when the user presses, on the list the cache
 * holds then (`decideProjectBoxWrite`), never on the list the box was drawn
 * from:
 *
 * - Pressing a free box ticks it, and pressing a ticked box unticks it, which
 *   removes only this page's server.
 * - Pressing a box whose list names another server of the same name writes
 *   nothing and shows the refusal; "Use ..." then writes the swap as one
 *   change, and "Keep ..." closes the refusal.
 * - The swap is written only while the list still names the server the
 *   refusal showed. When it names another one by now, nothing is written and
 *   the refusal shows that server instead, so the user confirms again.
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
  const { target } = box;
  // The id of the server the refusal showed, which "Use" replaces.
  const [refusedFor, setRefusedFor] = useState<string | null>(null);
  const mutationKey =
    target.kind === "default"
      ? mcpWriteKeys.defaultList()
      : mcpWriteKeys.projectList(target.project.id);
  // `null` means the project is gone, so there is no list to write. Only a project can be gone.
  const write = useMcpWrite<readonly string[] | null>({
    mutationKey,
    mutationFn: (mcpServerIds) => {
      if (target.kind === "default") {
        return client.settings.update({
          payload: { user: { "thread.mcpServerIds": [...mcpServerIds!] } },
        });
      }
      if (mcpServerIds === null) {
        throw new Error(`${target.project.name} no longer exists, so its list was not changed.`);
      }
      return client.project.update({
        params: { id: target.project.id },
        payload: { mcpServerIds: [...mcpServerIds] },
      });
    },
    refresh: [
      target.kind === "default" ? settingsQuery(client).queryKey : projectsQuery(client).queryKey,
    ],
  });
  const press = (action: ProjectBoxAction): void => {
    if (isMutationRunning(queryClient, mutationKey)) return;
    const currentIds =
      target.kind === "default"
        ? (queryClient.getQueryData(settingsQuery(client).queryKey)?.user["thread.mcpServerIds"] ??
          [])
        : queryClient
            .getQueryData(projectsQuery(client).queryKey)
            ?.find((each) => each.id === target.project.id)?.mcpServerIds;
    if (currentIds === undefined) {
      write.start(null);
      return;
    }
    // The box was drawn from these records, so they are in the cache.
    const views = readCachedMcpServerViews(queryClient, client)!;
    const decided = decideProjectBoxWrite(currentIds, views, view, action);
    if (decided.kind === "refused") {
      setRefusedFor(decided.occupant.server.id);
      return;
    }
    setRefusedFor(null);
    write.start(decided.mcpServerIds);
  };
  return (
    <ProjectBoxRow
      box={box}
      view={view}
      allProjects={projects}
      refusing={refusedFor !== null}
      busy={write.isRunning}
      error={write.refusal === null ? null : `Could not save: ${write.refusal}`}
      onTick={(ticked) => {
        press(ticked ? "tick" : "untick");
      }}
      onUse={() => {
        // A refusal exists only after a press found an occupant, so `refusedFor` is set.
        press({ swapFrom: refusedFor! });
      }}
      onKeep={() => {
        setRefusedFor(null);
      }}
    />
  );
}
