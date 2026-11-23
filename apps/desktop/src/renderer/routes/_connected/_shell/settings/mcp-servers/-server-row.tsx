import { useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildOfferSwitchTarget,
  type McpServerSettingsRow,
} from "@hercule/client-core/mcp-servers";
import type { McpServer } from "@hercule/contract";
import { useMcpServerSwitch } from "../../../../../app/mcp-server-switch";
import { pluginsQuery, projectsQuery } from "../../../../../app/queries";
import { ServerRowView } from "../../../../../screens/settings/mcp-servers/server-list";
import { ReplaceDialog } from "./-replace-dialog";

/**
 * Renders one row of "From your Connections" and owns its switch (spec 17
 * §Settings, MCP servers): a row with no record creates its server when
 * switched on, a row with a record turns it on or off, as the cache holds it
 * when the switch is pressed. While the write runs
 * the switch ignores presses. A refusal shows under the row, in the
 * controller's words. The refusal and the guard belong to the row's target,
 * not to the row, so closing the section and opening it again keeps a write
 * that still runs.
 *
 * Switching on a row with no record while servers added by URL sit on its
 * address opens the Replace dialog and writes nothing.
 */
export function ServerRow({ row }: { readonly row: McpServerSettingsRow }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const { view } = row;
  const flip = useMcpServerSwitch(buildOfferSwitchTarget(row));
  // The servers added by URL the switch found on the offer's address, while the dialog is open.
  const [replacing, setReplacing] = useState<readonly McpServer[] | null>(null);
  return (
    <>
      <ServerRowView
        row={row}
        plugins={plugins}
        allProjects={projects}
        busy={flip.blocked}
        refusal={flip.problem}
        onFlip={() => {
          const pressed = flip.press(!(view?.server.enabled ?? false));
          if (pressed.kind === "replace") setReplacing(pressed.candidates);
        }}
      />
      {replacing !== null && (
        <ReplaceDialog
          row={row}
          candidates={replacing}
          onClose={() => {
            setReplacing(null);
          }}
        />
      )}
    </>
  );
}
