import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import {
  buildMcpServerViews,
  buildProjectBoxes,
  listKnownServerIds,
  type McpServerView,
} from "@hercule/client-core/mcp-servers";
import { FormCard } from "@hercule/ui";
import {
  connectionsQuery,
  mcpServersQuery,
  pluginsQuery,
  projectsQuery,
  settingsQuery,
} from "../../../../app/queries";
import { CardHeading } from "./-card-heading";
import { ProjectBoxRow } from "./-project-box";

/**
 * The "Projects" card of a server's page: one box for each project and one for
 * the threads without a project. This is the one place a project is given a
 * server.
 */
export function Projects({
  client,
  view,
}: {
  readonly client: HerculeClient;
  /** The server the page is about. */
  readonly view: McpServerView;
}): JSX.Element {
  const servers = useSuspenseQuery(mcpServersQuery(client)).data.items;
  const connections = useSuspenseQuery(connectionsQuery(client)).data.items;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data.items;
  const settings = useSuspenseQuery(settingsQuery(client)).data;

  // The page's own record is read on its own, so a list that was read a moment
  // earlier may not hold it yet. The choice of a server by name needs it.
  const views = [
    ...buildMcpServerViews(servers, connections, plugins).filter(
      (each) => each.server.id !== view.server.id,
    ),
    view,
  ];
  // The default list is never rewritten when a server is deleted, so the
  // start list of a thread in no project is what drops the ids no server has.
  const defaultIds = listKnownServerIds(settings.user["thread.mcpServerIds"] ?? [], views);
  const boxes = buildProjectBoxes(view, views, projects, defaultIds);

  return (
    <FormCard
      label={
        <CardHeading
          title="Projects"
          aside={`${String(boxes.filter((box) => box.ticked).length)} of ${String(boxes.length)}`}
        />
      }
    >
      <p className="text-fine text-faint">
        A thread starts with this server when its project names it. A thread can still change its
        own list, under the plus of its composer.
      </p>
      <ul className="flex flex-col">
        {boxes.map((box) => (
          <ProjectBoxRow
            key={box.target.kind === "project" ? box.target.project.id : "default"}
            client={client}
            view={view}
            box={box}
          />
        ))}
      </ul>
    </FormCard>
  );
}
