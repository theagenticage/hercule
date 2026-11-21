import { useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import { buildMcpServerViews } from "@hercule/client-core/mcp-servers";
import {
  connectionsQuery,
  mcpServersQuery,
  pluginsQuery,
  settingsQuery,
} from "../../../../../app/queries";
import { DefaultServers } from "../../../../../screens/settings/mcp-servers/server-list";
import { ServerPickerDialog } from "../../../../../screens/settings/mcp-servers/server-picker";
import { readServersAgain } from "./-keep-server";

/**
 * Renders the group "Threads without a project" and owns its picker (spec 17
 * §Settings, MCP servers). The group shows the servers of the setting
 * `thread.mcpServerIds`. Change… opens the picker, which writes the setting
 * with `settings.update` at once on each change.
 *
 * The picker computes each new list from the setting as this component last
 * drew it. That is the current setting: while a write runs the picker ignores
 * changes, and the write counts as running until the setting is read again,
 * so a second change never starts from a list the first one replaced. A
 * server that was deleted is already left out of the setting by the read.
 */
export function DefaultList(): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const servers = useSuspenseQuery(mcpServersQuery(client)).data;
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const [picking, setPicking] = useState(false);
  const write = useMutation({
    mutationFn: async (mcpServerIds: readonly string[]) => {
      const saved = await client.settings.update({
        payload: { user: { "thread.mcpServerIds": mcpServerIds } },
      });
      queryClient.setQueryData(settingsQuery(client).queryKey, saved);
    },
    onSettled: async () => {
      await readServersAgain(queryClient, client, undefined, [settingsQuery(client).queryKey]);
    },
  });
  const views = buildMcpServerViews(servers, connections, plugins);
  const mcpServerIds = settings.user["thread.mcpServerIds"] ?? [];
  const chosen = mcpServerIds.flatMap((id) => views.find((view) => view.server.id === id) ?? []);
  return (
    <>
      <DefaultServers
        chosen={chosen}
        plugins={plugins}
        onChange={() => {
          write.reset();
          setPicking(true);
        }}
      />
      {picking && (
        <ServerPickerDialog
          views={views}
          plugins={plugins}
          mcpServerIds={mcpServerIds}
          title="MCP servers of threads without a project"
          foot="A thread in no project starts with this list. Each change is saved as you make it."
          reset={null}
          busy={write.isPending}
          error={write.error === null ? null : `Could not save: ${readErrorMessage(write.error)}`}
          onChange={(ids) => {
            write.mutate(ids);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
