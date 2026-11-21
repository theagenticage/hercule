import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { McpServer } from "@hercule/contract";
import { mcpServerQuery, mcpServersQuery } from "../../../../../app/queries";

/**
 * Puts `saved`, a server the controller returned from a write, in the cached
 * list and in the cached read of its own page, so every screen shows it at
 * once: replaced where the list has it, added at the end where it does not.
 * The caller then reads both again, which puts the list in the controller's
 * order.
 */
export const keepSavedServer = (
  queryClient: QueryClient,
  client: HerculeClient,
  saved: McpServer,
): void => {
  queryClient.setQueryData(mcpServersQuery(client).queryKey, (servers) =>
    servers === undefined
      ? undefined
      : servers.some((each) => each.id === saved.id)
        ? servers.map((each) => (each.id === saved.id ? saved : each))
        : [...servers, saved],
  );
  queryClient.setQueryData(mcpServerQuery(client, saved.id).queryKey, saved);
};

/**
 * Reads the list of servers again, and the page of server `serverId` when
 * one is given. Resolves when both reads have answered, which is what keeps
 * the controls of a write disabled until the screen shows the result.
 * `alsoRead` lists the other queries a write changed, such as the projects.
 */
export const readServersAgain = async (
  queryClient: QueryClient,
  client: HerculeClient,
  serverId: string | undefined,
  alsoRead: ReadonlyArray<readonly unknown[]> = [],
): Promise<void> => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: mcpServersQuery(client).queryKey, exact: true }),
    serverId === undefined
      ? undefined
      : queryClient.invalidateQueries({
          queryKey: mcpServerQuery(client, serverId).queryKey,
          exact: true,
        }),
    ...alsoRead.map((queryKey) => queryClient.invalidateQueries({ queryKey, exact: true })),
  ]);
};
