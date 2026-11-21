import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { McpServer } from "@hercule/contract";
import { keepSavedServer, readServersAgain } from "./-keep-server";

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

/** What one press of a switch asks for: `on` is the state the switch is going to. */
export interface ServerSwitchPress {
  readonly target: ServerSwitchTarget;
  readonly on: boolean;
}

/**
 * Returns the write behind one server's switch, on the list and on the page.
 * `mutate` sends `mcpServer.create` or `mcpServer.update` as the press's
 * target says. The result is put in the cached list and page at once, and the
 * mutation counts as running until both are read again, so the switch never
 * shows the old state in between. A refusal, such as the `conflict` of a
 * second server for one Connection, keeps its message in `error`, and the
 * list is read again, because the refusal may mean it was out of date.
 *
 * Each component that has a switch makes its own, so each switch's busy
 * state and refusal stay with it.
 */
export function useServerSwitch(): UseMutationResult<McpServer, Error, ServerSwitchPress> {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ target, on }: ServerSwitchPress) =>
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
    onSuccess: (saved) => {
      keepSavedServer(queryClient, client, saved);
    },
    onSettled: async (saved, _error, { target }) => {
      await readServersAgain(
        queryClient,
        client,
        target.kind === "update" ? target.serverId : saved?.id,
      );
    },
  });
}
