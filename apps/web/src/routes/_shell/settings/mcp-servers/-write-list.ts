import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import { projectsQuery, settingsQuery } from "../../../../app/queries";

/** A list of MCP Servers that Settings edits: one project's, or the default list. */
export type ServerListTarget =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "default" };

/**
 * Returns the ids the target's list holds in the query cache right now, so a
 * choice is applied to the newest list the screen has and never to the one a
 * component drew a while ago. Throws when the target's project is no longer in
 * the cache, which means it was deleted.
 */
const readCurrentList = (
  queryClient: QueryClient,
  client: HerculeClient,
  target: ServerListTarget,
): readonly string[] => {
  if (target.kind === "default") {
    return (
      queryClient.getQueryData(settingsQuery(client).queryKey)?.user["thread.mcpServerIds"] ?? []
    );
  }
  const project = queryClient
    .getQueryData(projectsQuery(client).queryKey)
    ?.items.find((each) => each.id === target.projectId);
  if (project === undefined) {
    throw new Error("This project no longer exists, so its list cannot change.");
  }
  return project.mcpServerIds;
};

/**
 * Returns a mutation that writes a list of MCP Servers, project or default.
 * `mutate` takes a function from the list as it is in the cache when the
 * write starts to the list to write, so two quick choices never overwrite each
 * other. A caller that already holds the whole new list passes `() => ids`.
 *
 * The mutation is pending until the target's read has been fetched again, so
 * a control that disables itself while `isPending` never shows the old list
 * between the write and its refresh. A refusal (such as two servers of one
 * name) is the mutation's `error`, and the list stays as the controller holds
 * it.
 */
export const useWriteServerList = (client: HerculeClient, target: ServerListTarget) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (choose: (current: readonly string[]) => readonly string[]) => {
      const mcpServerIds = choose(readCurrentList(queryClient, client, target));
      if (target.kind === "project") {
        await client.project.update({
          params: { id: target.projectId },
          payload: { mcpServerIds },
        });
      } else {
        await client.settings.update({
          payload: { user: { "thread.mcpServerIds": mcpServerIds } },
        });
      }
    },
    onSettled: () =>
      target.kind === "project"
        ? Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
            queryClient.invalidateQueries({ queryKey: queryKeys.project(target.projectId) }),
          ])
        : queryClient.invalidateQueries({ queryKey: queryKeys.settings() }),
  });
};
