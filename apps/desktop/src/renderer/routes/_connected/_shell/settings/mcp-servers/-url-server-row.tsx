import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { UrlServerSettingsRow } from "@hercule/client-core/mcp-servers";
import { useMcpServerSwitch } from "../../../../../app/mcp-server-switch";
import { projectsQuery } from "../../../../../app/queries";
import { UrlServerRowView } from "../../../../../screens/settings/mcp-servers/server-list";

/**
 * Renders one row of "Added by URL" and owns its switch (spec 17 §Settings,
 * MCP servers): the switch writes `enabled` of the server's record, one write
 * at a time, whichever control started it. A refusal shows under the row in
 * the controller's words. The guard and the refusal belong to the server, not
 * to the row, so the page of the same server shares them.
 */
export function UrlServerRow({ row }: { readonly row: UrlServerSettingsRow }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const { server } = row.view;
  const flip = useMcpServerSwitch({ kind: "url", serverId: server.id });
  return (
    <UrlServerRowView
      row={row}
      allProjects={projects}
      busy={flip.blocked}
      refusal={flip.problem}
      onFlip={() => {
        flip.press(!server.enabled);
      }}
    />
  );
}
