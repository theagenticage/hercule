/**
 * How the Work screen reads the board: the query, and the hook that gates it
 * on the window being visible. They live beside the route, not in
 * `app/queries.ts`, because the board is not shell data: nothing but this
 * screen reads it, and the shell's chunk should not carry it.
 */
import { queryOptions, useQuery } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import { buildWorkBoardKey } from "@hercule/client-core/work";
import { LIVE_KEPT_READ_OPTIONS } from "../../../app/queries";
import { useWindowVisible } from "../../../app/window-visibility";

/**
 * Returns the query that reads the board: the cards of every unfinished Task,
 * in stored order. Like every live read, it stays fresh until a push says
 * otherwise, and it is not read again for focus or reconnect.
 */
export const workBoardQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: buildWorkBoardKey(),
    queryFn: () => client.task.queryBoard(),
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
