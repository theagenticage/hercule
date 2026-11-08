/**
 * Asking the controller whether a merge would be refused, before the user
 * drops or confirms it (`task.checkMerge`). The answer is a query keyed by the
 * pair of Tasks, so pointing at the same pair again within a few seconds does
 * not ask again, unless a `task` push came meanwhile: that marks every answer
 * out of date (see `queryKeys.mergeCheck`), because a blocker added or removed
 * changes it.
 */
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import { readMergeCheck, type MergeCheckResult } from "@hercule/client-core/work";

/**
 * How long, in milliseconds, an answer is reused when no `task` push marked it
 * out of date. It is short because the controller's merge always decides in
 * the end.
 */
const MERGE_CHECK_STALE_MS = 10_000;

/** Returns the query that asks whether the Task `sourceId` could be merged into the Task `intoTaskId`. */
export const mergeCheckQuery = (client: HerculeClient, sourceId: string, intoTaskId: string) =>
  queryOptions({
    queryKey: queryKeys.mergeCheck(sourceId, intoTaskId),
    queryFn: async () =>
      readMergeCheck(
        await client.task.checkMerge({ params: { id: sourceId }, query: { intoTaskId } }),
      ),
    staleTime: MERGE_CHECK_STALE_MS,
    retry: false,
  });

/**
 * Asks whether the Task `sourceId` could be merged into the Task `intoTaskId`.
 * Never fails: when the question cannot be asked (offline, an error), the
 * result is `unchecked`, which is not an approval. The merge then decides.
 */
export const askMergeCheck = async (
  queryClient: QueryClient,
  client: HerculeClient,
  sourceId: string,
  intoTaskId: string,
): Promise<MergeCheckResult> => {
  try {
    return await queryClient.fetchQuery(mergeCheckQuery(client, sourceId, intoTaskId));
  } catch {
    return { kind: "unchecked" };
  }
};
