import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildMcpServerViews,
  buildProjectBoxes,
  type McpServerView,
  type ProjectBox,
  type ProjectBoxAction,
} from "@hercule/client-core/mcp-servers";
import { useMcpListEdit } from "../../../../../app/mcp-list-edits";
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
  const settingsRead = useSuspenseQuery(settingsQuery(client));
  const settings = settingsRead.data;
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
          settingsReading={settingsRead.isFetching}
        />
      ))}
    </ProjectsSection>
  );
}

/**
 * Renders one box and owns its edit. One edit of the box's list runs at a
 * time, wherever it was started from, and counts as running until the list
 * is read again (see `useMcpListEdit`); while it runs the box ignores
 * presses. The default box also ignores them while the default list is read
 * again as the page opens, because the list drawn may be older than the
 * controller's. A refusal shows under the box.
 *
 * What a press writes is decided when the user presses, on the list the cache
 * holds then, never on the list the box was drawn from:
 *
 * - Pressing a free box ticks it, and pressing a ticked box unticks it, which
 *   removes only this page's server.
 * - Pressing a box whose list names another server of the same name writes
 *   nothing and shows the refusal; "Use ..." then writes the swap as one
 *   change, and "Keep ..." closes the refusal.
 * - The refusal names the server the box's list names now, and "Use ..."
 *   swaps that same server, so the words and the button never differ. The
 *   swap is written only while the list still names it in the cache. When it
 *   names another one by then, nothing is written and the refusal shows that
 *   server instead, so the user confirms again.
 */
function ProjectBoxItem({
  box,
  view,
  settingsReading,
}: {
  readonly box: ProjectBox;
  readonly view: McpServerView;
  /** Whether the default list is being read again, which the default box waits for. */
  readonly settingsReading: boolean;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const { target } = box;
  const edit = useMcpListEdit(
    target.kind === "default"
      ? { kind: "default" }
      : { kind: "project", projectId: target.project.id },
  );
  // The refusal belongs to this page only when it was made for this page's server. The box
  // words it with the server the list names now, so the words and "Use ..." never differ.
  const { refusal } = edit;
  const refusing = refusal?.kind === "taken" && refusal.serverId === view.server.id;
  const occupantId = box.takenBy?.server.id;
  const press = (action: ProjectBoxAction): void => {
    edit.apply({ kind: "box", serverId: view.server.id, action });
  };
  return (
    <ProjectBoxRow
      box={box}
      view={view}
      allProjects={projects}
      refusing={refusing}
      busy={edit.blocked || (target.kind === "default" && settingsReading)}
      error={refusal?.kind === "taken" ? null : edit.problem("Could not save: ")}
      onTick={(ticked) => {
        press(ticked ? "tick" : "untick");
      }}
      onUse={() => {
        // The button shows only while the box names another server, which the refusal describes.
        if (occupantId !== undefined) press({ swapFrom: occupantId });
      }}
      onKeep={edit.clearRefusal}
    />
  );
}
