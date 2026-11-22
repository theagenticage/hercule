import { Suspense, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildMcpServerViews } from "@hercule/client-core/mcp-servers";
import { useMcpListEdit } from "../../../../../app/mcp-list-edits";
import {
  connectionsQuery,
  mcpServersQuery,
  pluginsQuery,
  settingsQuery,
} from "../../../../../app/queries";
import { DefaultServers } from "../../../../../screens/settings/mcp-servers/server-list";
import { LazyServerPickerDialog } from "../../../../../screens/settings/mcp-servers/lazy-server-picker";

/**
 * Renders the group "Threads without a project" and owns its picker (spec 17
 * §Settings, MCP servers). The group shows the servers of the setting
 * `thread.mcpServerIds`. Change… opens the picker, which writes the setting
 * with `settings.update` at once on each change.
 *
 * The picker sends each click as a choice, which is applied to the setting
 * as the cache holds it when the edit runs (see `useMcpListEdit`), so a
 * setting that was read again since the picker drew is never replaced by an
 * older list. One edit of the setting runs at a time, wherever it was started
 * from, and counts as running until the setting is read again. Closing and
 * opening the picker keeps that guard. A server that was deleted is already
 * left out of the setting by the read.
 */
export function DefaultList(): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const settingsRead = useSuspenseQuery(settingsQuery(client));
  const settings = settingsRead.data;
  const servers = useSuspenseQuery(mcpServersQuery(client)).data;
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const [picking, setPicking] = useState(false);
  const edit = useMcpListEdit({ kind: "default" });
  const views = buildMcpServerViews(servers, connections, plugins);
  const mcpServerIds = settings.user["thread.mcpServerIds"] ?? [];
  const chosen = mcpServerIds.flatMap((id) => views.find((view) => view.server.id === id) ?? []);
  return (
    <>
      <DefaultServers
        chosen={chosen}
        plugins={plugins}
        changeOff={settingsRead.isFetching}
        onChange={() => {
          setPicking(true);
        }}
      />
      {picking && (
        <Suspense fallback={null}>
          <LazyServerPickerDialog
            views={views}
            plugins={plugins}
            mcpServerIds={mcpServerIds}
            title="MCP servers of threads without a project"
            foot="A thread in no project starts with this list. Each change is saved as you make it."
            reset={null}
            busy={edit.blocked}
            error={edit.problem("Could not save: ")}
            onChoose={edit.apply}
            onClose={() => {
              // Closing the picker dismisses what it showed. A refusal that came after it closed stays.
              edit.clearRefusal();
              setPicking(false);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
