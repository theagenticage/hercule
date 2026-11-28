/**
 * How the Work screen reads the board: the query, and the hook that gates it
 * on the window being visible. They live beside the route, not in
 * `app/queries.ts`, because the board is not shell data: nothing but this
 * screen reads it, and the shell's chunk should not carry it.
 */
import { queryOptions, useQuery } from "@tanstack/react-query";
import { queryKeys, readEveryPage, type HerculeClient } from "@hercule/client-core";
import { LIVE_KEPT_READ_OPTIONS } from "../../../app/queries";
import { useWindowVisible } from "../../../app/window-visibility";

/**
 * Returns the query that reads the board: the cards of every unfinished Task,
 * in stored order. Like every live read, it stays fresh until a push says
 * otherwise, and it is not read again for focus or reconnect.
 */
export const workBoardQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.workBoard(),
    queryFn: () => client.task.queryBoard(),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Returns the query that reads the open Initiatives, every page, in creation
 * order. Work reads it beside the board. A closed Initiative is left out, and
 * its cards go back to their lanes.
 */
export const initiativesQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.initiatives(),
    queryFn: () => readEveryPage((page) => client.initiative.query({ query: page })),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads the open Initiatives while the window is visible, like `useWorkBoard`.
 * `data` is `undefined` until the first read ends.
 */
export const useWorkInitiatives = (client: HerculeClient) => {
  const isVisible = useWindowVisible();
  return useQuery({ ...initiativesQuery(client), enabled: isVisible });
};

/**
 * Returns the query that reads what the details pane of one Task draws: the
 * Task, its card with the summary, its Threads and its runs. Like every live
 * read, it stays fresh until a push says otherwise. A `task` push that names
 * the Task reads it again, a derived one too (see `buildQueryKeys`).
 *
 * The route's loader never starts it: the pane starts it when it opens, and
 * draws its quiet bars until it ends.
 */
export const taskDetailQuery = (client: HerculeClient, taskId: string) =>
  queryOptions({
    queryKey: queryKeys.taskDetail(taskId),
    queryFn: () => client.task.readDetail({ params: { id: taskId } }),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads the board while the window is visible. A hidden window starts no read:
 * a push that arrives meanwhile only marks the board out of date, and the
 * board is read once when the window shows again.
 *
 * `data` is `undefined` until the first read ends. The route's loader starts
 * that read without waiting for it, so the screen draws its loading state at
 * once, with the stage names and lanes already in place.
 */
export const useWorkBoard = (client: HerculeClient) => {
  const isVisible = useWindowVisible();
  return useQuery({ ...workBoardQuery(client), enabled: isVisible });
};

/**
 * Returns the query that finds out whether the controller has any Task at
 * all, finished ones included, which tells the first-run page from the page
 * of a desk that is clear. It is read only while the board is empty.
 */
export const hasAnyTaskQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: [...queryKeys.tasks(), "any"],
    queryFn: async () => (await client.task.query({ query: { limit: 1 } })).items.length > 0,
    ...LIVE_KEPT_READ_OPTIONS,
  });
