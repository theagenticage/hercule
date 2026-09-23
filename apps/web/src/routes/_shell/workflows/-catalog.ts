/**
 * The data the workflow editor uses for autocomplete: the actions a step can
 * use, the event kinds a trigger can use, and the Agents. The new and the
 * stored workflow pages both load it before they render.
 *
 * The route files import this file before the page itself loads, so it must
 * not use hooks. A hook here would pull React Query's React code into the
 * app's first load.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { agentsQuery, eventKindsQuery, workflowActionsQuery } from "../../../app/queries";

/** Loads the three autocomplete lists into the query cache. Resolves at once when they are cached. */
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
