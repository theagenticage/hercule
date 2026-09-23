/**
 * What the editor completes from: the actions a step can name, the event
 * kinds a trigger can name, and the Agents. The two pages of the editor read
 * the three before they show, so the page never waits on them.
 *
 * The route files load this file before the page, so it reads nothing with a
 * hook: a hook here would bring the query library's React part into the first
 * paint of the app.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { agentsQuery, eventKindsQuery, workflowActionsQuery } from "../../../app/queries";

/** Reads the three catalogs into the cache, or answers at once when the cache holds them. */
export const prefetchWorkflowCatalog = async (
  client: HerculeClient,
  queryClient: QueryClient,
): Promise<void> => {
  await Promise.all([
    queryClient.ensureQueryData(workflowActionsQuery(client)),
    queryClient.ensureQueryData(eventKindsQuery(client)),
    queryClient.ensureQueryData(agentsQuery(client)),
  ]);
};
