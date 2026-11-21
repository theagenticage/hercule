import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { McpServerSettingsRow } from "@hercule/client-core/mcp-servers";
import { pluginsQuery, projectsQuery } from "../../../../../app/queries";
import { ServerRowView } from "../../../../../screens/settings/mcp-servers/server-list";
import { useServerSwitch } from "./-switch-server";

/**
 * Renders one row of "From your Connections" and owns its switch (spec 17
 * §Settings, MCP servers): a row with no record creates its server when
 * switched on, a row with a record turns it on or off. While the write runs
 * the switch ignores presses. A refusal shows under the row, in the
 * controller's words, for as long as the row is in the state the write was
 * made from: the refusal belongs to the row's target, so once the list shows
 * the row differently, such as a server that another client created, the
 * message no longer describes it. Closing the section and opening it again
 * keeps a write that still runs, and its refusal.
 */
export function ServerRow({ row }: { readonly row: McpServerSettingsRow }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const { view } = row;
  const target =
    view === null
      ? ({
          kind: "create",
          contributionId: row.offer.contributionId,
          connectionId: row.connection.id,
        } as const)
      : ({ kind: "update", serverId: view.server.id } as const);
  const flip = useServerSwitch(target);
  return (
    <ServerRowView
      row={row}
      plugins={plugins}
      allProjects={projects}
      busy={flip.isRunning}
      refusal={flip.refusal}
      onFlip={() => {
        flip.start(!(view?.server.enabled ?? false));
      }}
    />
  );
}
