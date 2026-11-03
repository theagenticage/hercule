/**
 * How the two Fleet pages read and follow Runner Metrics (spec 17 §Graphs and
 * the forecast): the query of one history, and the hook that reads it again on
 * a `runnerMetrics` nudge. They live beside the Fleet routes, not in
 * `app/queries.ts` and `app/live.ts`, because those load with the shell and
 * this pulls the Fleet modules of `client-core` in with it.
 */
import { useEffect } from "react";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  queryKeys,
  type HerculeClient,
  type Live,
  type LiveInvalidatePush,
} from "@hercule/client-core";
import {
  buildMachineFiveMinuteScope,
  EMPTY_RUNNER_METRICS_HISTORY,
  FLEET_HOUR_METRICS_SCOPE,
  readRunnerMetricsHistory,
  type RunnerMetricsHistory,
  type RunnerMetricsScope,
} from "@hercule/client-core/metrics-history";
import { LIVE_KEPT_READ_OPTIONS } from "../../../../app/queries";
import { useWindowVisible } from "../../../../app/window-visibility";

/**
 * Reads one history of Runner Metrics (spec 03 §4.3): the first read covers
 * the whole range, and each later one starts at the newest point the cache
 * holds (`readRunnerMetricsHistory`), so a read after a nudge brings one or two
 * points, not the range again.
 *
 * Nothing makes this read stale on its own: the `runnerMetrics` topic maps to
 * no key, and `useRunnerMetricsLive` decides which histories to read again on
 * each nudge. The query never reads for time, focus or reconnect either.
 */
export const runnerMetricsQuery = (client: HerculeClient, scope: RunnerMetricsScope) => {
  const queryKey = queryKeys.runnerMetrics(scope);
  return queryOptions({
    queryKey,
    queryFn: ({ client: queryClient }): Promise<RunnerMetricsHistory> =>
      readRunnerMetricsHistory(
        client,
        scope,
        queryClient.getQueryData<RunnerMetricsHistory>(queryKey) ?? EMPTY_RUNNER_METRICS_HISTORY,
        Date.now(),
      ),
    ...LIVE_KEPT_READ_OPTIONS,
  });
};

/** How old the Fleet page's history of hour points must be before a nudge reads it again. */
const HOUR_HISTORY_REFRESH_MS = 60 * 60 * 1000;

/**
 * Reads again what a `runnerMetrics` push makes out of date on a Fleet page. A
 * push says the controller wrote a row of Runner Metrics for each runner it
 * names, or for any runner when it names none. `runnerId` is the machine whose
 * page is open, or `null` on the Fleet page, which draws every machine.
 *
 * - A machine's page ignores a push that names other runners only: with five
 *   machines, the other four's nudges would otherwise read the runners and
 *   its history four times a minute for nothing.
 * - The runners are read again, for the latest metrics on the cards and the
 *   machine page. A routine report publishes nothing on `runner`.
 * - A machine's page reads its five-minute history again from the start of its
 *   newest point. That point was still filling. The page holds no other
 *   history.
 * - The Fleet page reads its history of hour points again only when its last
 *   successful read is an hour old or more, so a nudge a minute changes none
 *   of them within the hour. The age is the query's `dataUpdatedAt`, not the
 *   history's own `readAt`, which does not move when a read brings no new
 *   point. A history that is being read is not left alone: a report written
 *   after that read's query ran would otherwise wait another hour.
 *
 * Reading goes through `invalidateWithoutCancelling`, so however many nudges
 * arrive, a history has at most one read running and one more waiting.
 */
const readAgainForPush = (
  queryClient: QueryClient,
  runnerId: string | null,
  push: LiveInvalidatePush,
): void => {
  if (runnerId !== null && push.ids.length > 0 && !push.ids.includes(runnerId)) return;
  invalidateWithoutCancelling(queryClient, queryKeys.runners());
  if (runnerId !== null) {
    invalidateWithoutCancelling(
      queryClient,
      queryKeys.runnerMetrics(buildMachineFiveMinuteScope(runnerId)),
    );
    return;
  }
  const hourKey = queryKeys.runnerMetrics(FLEET_HOUR_METRICS_SCOPE);
  const readAt = queryClient.getQueryState(hourKey)?.dataUpdatedAt ?? 0;
  if (Date.now() - readAt >= HOUR_HISTORY_REFRESH_MS) {
    invalidateWithoutCancelling(queryClient, hourKey);
  }
};

/**
 * Keeps the Runner Metrics a Fleet page draws current while the calling
 * component is mounted and the window is visible: subscribes to the
 * `runnerMetrics` topic and reads what each nudge makes out of date (see
 * `readAgainForPush`). Pass the id of the machine whose page is open, or
 * `null` on the Fleet page. No other screen holds this topic.
 *
 * It drops the subscription while the window is hidden (spec 17 §Rules, rule
 * 3). The controller's first push on a subscription names no runner, so
 * showing the window reads everything the page holds that is not fresh.
 */
export const useRunnerMetricsLive = (
  live: Live,
  queryClient: QueryClient,
  runnerId: string | null,
): void => {
  const visible = useWindowVisible();
  useEffect(() => {
    if (!visible) return;
    return live.subscribe("runnerMetrics", (_keys, push) => {
      readAgainForPush(queryClient, runnerId, push);
    });
  }, [live, queryClient, runnerId, visible]);
};
