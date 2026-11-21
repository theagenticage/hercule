import { useRouteContext } from "@tanstack/react-router";
import { mcpWriteKeys, useMcpWrite, type McpWrite } from "../../../../../app/mcp-write";
import { mcpServerQuery, mcpServersQuery } from "../../../../../app/queries";

/**
 * What a switch of Settings > MCP servers writes:
 *
 * - `create`: the Connection's server has no record yet, so switching it on
 *   creates it from the plugin's contribution and the Connection;
 * - `update`: the server has a record, which the switch turns on or off.
 *   Off is never a delete.
 */
export type ServerSwitchTarget =
  | {
      readonly kind: "create";
      readonly contributionId: string;
      readonly connectionId: string;
    }
  | { readonly kind: "update"; readonly serverId: string };

/**
 * Returns the write behind the switch of `target`, on the list and on the
 * page. `start(on)` sends `mcpServer.create`, or `mcpServer.update` with the
 * state the switch is going to. The mutation counts as running until the
 * list and the page are read again, so the switch never shows the old state
 * in between, and the response is never put in the cache. A refusal, such as
 * the `conflict` of a second server for one Connection, stays with the
 * target, whichever control shows it, and the list is read again, because the
 * refusal may mean it was out of date.
 */
export function useServerSwitch(target: ServerSwitchTarget): McpWrite<boolean> {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  return useMcpWrite<boolean>({
    mutationKey:
      target.kind === "create"
        ? mcpWriteKeys.serverCreation(target.contributionId, target.connectionId)
        : mcpWriteKeys.serverSwitch(target.serverId),
    mutationFn: (on) =>
      target.kind === "create"
        ? client.mcpServer.create({
            payload: {
              source: {
                kind: "plugin",
                contributionId: target.contributionId,
                connectionId: target.connectionId,
              },
            },
          })
        : client.mcpServer.update({ params: { id: target.serverId }, payload: { enabled: on } }),
    refresh:
      target.kind === "create"
        ? [mcpServersQuery(client).queryKey]
        : [mcpServersQuery(client).queryKey, mcpServerQuery(client, target.serverId).queryKey],
  });
}
