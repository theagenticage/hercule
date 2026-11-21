import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import { projectsQuery, settingsQuery } from "../../../../app/queries";
import { isValidationRefusal, useKeyedWrite } from "../../../../app/use-keyed-write";
import type { ListUpdate } from "../../../../screens/mcp-server-picker";

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
 * Returns a write of a list of MCP Servers, project or default, keyed by the
 * target: whichever control starts a write of the target's list, a second
 * write waits until the first has ended and its list has been read again, even
 * if the control was closed and opened in between. `write` takes a function
 * from the list as it is in the cache when the write starts to the list to
 * write, so two quick choices never overwrite each other and a choice never
 * sends back a list a control drew a while ago. A function that throws refuses
 * the write before anything is sent.
 *
 * A refusal (such as two servers of one name) is `refusal`; it stays with the
 * target until the next write or `clearRefusal`, and the list stays as the
 * controller holds it. A refusal as invalid also reads the servers again,
 * because it can mean a server in the list was deleted.
 */
export const useWriteServerList = (client: HerculeClient, target: ServerListTarget) => {
  const queryClient = useQueryClient();
  return useKeyedWrite<ListUpdate>({
    mutationKey:
      target.kind === "project"
        ? ["mcp-list", "project", target.projectId]
        : ["mcp-list", "default"],
    mutationFn: async (update) => {
      const mcpServerIds = update(readCurrentList(queryClient, client, target));
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
    onSettled: (error) =>
      Promise.all([
        target.kind === "project"
          ? Promise.all([
              queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
              queryClient.invalidateQueries({ queryKey: queryKeys.project(target.projectId) }),
            ])
          : queryClient.invalidateQueries({ queryKey: queryKeys.settings() }),
        // An invalid list can name a server that was deleted since the servers were read.
        isValidationRefusal(error)
          ? queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers() })
          : undefined,
      ]),
  });
};
