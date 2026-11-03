/**
 * The read of Runner Metrics the two Fleet pages make (spec 17 §Graphs and
 * the forecast). It lives beside the Fleet routes, not in `app/queries.ts`,
 * because that file loads with the shell and this read pulls the Fleet modules
 * of `client-core` in with it.
 */
import { queryOptions } from "@tanstack/react-query";
import { readEveryPage, type HerculeClient } from "@hercule/client-core";
import {
  EMPTY_RUNNER_METRICS_HISTORY,
  findMetricsReadStart,
  mergeRunnerMetricsHistory,
  type RunnerMetricsHistory,
} from "@hercule/client-core/metrics-history";
import { LIVE_KEPT_READ_OPTIONS } from "../../../../app/queries";
import {
  buildRunnerMetricsKey,
  type RunnerMetricsScope,
} from "../../../../screens/fleet/runner-metrics-scope";

/**
 * Reads one history of Runner Metrics (spec 03 §4.3). The first read covers
 * the whole range. Every later read starts at the newest point the cache holds
 * and joins to it (`mergeRunnerMetricsHistory`), so a read after a nudge
 * brings one or two points, not the range again.
 *
 * Every page of a read carries the same `until`, the time the read started.
 * Without it, each page would end at the controller's own time, and a read
 * that crosses an hour boundary between two pages could return one runner's
 * 10:00 hour half filled and another's 11:00 hour. The next read would start
 * at 11:00 and the first runner's 10:00 would never be completed. It also
 * keeps a point from starting after the history's right edge when the
 * controller's clock is ahead of this Mac's.
 *
 * Nothing makes this read stale on its own: the `runnerMetrics` topic maps to
 * no key, and `useRunnerMetricsLive` decides which histories to read again on
 * each nudge. The query never reads for time, focus or reconnect either.
 */
export const runnerMetricsQuery = (client: HerculeClient, scope: RunnerMetricsScope) => {
  const { resolution, runnerId, rangeMs } = scope;
  const queryKey = buildRunnerMetricsKey(scope);
  return queryOptions({
    queryKey,
    queryFn: async ({ client: queryClient }): Promise<RunnerMetricsHistory> => {
      const held =
        queryClient.getQueryData<RunnerMetricsHistory>(queryKey) ?? EMPTY_RUNNER_METRICS_HISTORY;
      const readAt = Date.now();
      const until = new Date(readAt).toISOString();
      const since = findMetricsReadStart(held, resolution, rangeMs, readAt);
      const read = await readEveryPage((page) =>
        client.runnerMetrics.query({
          query: {
            ...(runnerId === null ? {} : { runnerId }),
            since,
            until,
            resolution,
            ...page,
          },
        }),
      );
      return mergeRunnerMetricsHistory(held, read, since, readAt, rangeMs);
    },
    ...LIVE_KEPT_READ_OPTIONS,
  });
};
