/**
 * What the machine page's loader reads for the Storage section of a machine
 * (spec 17 §Fleet, A machine's page, point 5), and the time the section counts
 * at. The reads themselves are in `app/machine-storage-queries.ts`.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { computeDayStart } from "@hercule/client-core/list-time";
import { canMeasureStorage } from "@hercule/client-core/machine-storage";
import { FLEET_HOUR_METRICS_SCOPE } from "@hercule/client-core/metrics-history";
import {
  cleanupThreadsQuery,
  listCleanupCandidateIds,
  negotiatedCapabilitiesQuery,
} from "../../../../app/machine-storage-queries";
import { workspacesQuery } from "../../../../app/queries";
import { runnerMetricsQuery } from "./-runner-metrics";

/**
 * Decides the time the Storage section counts idleness, the forecast and the
 * day of the last sweep at. It is the time the Fleet page's hour points were
 * read (`hourPointsReadAt`, Unix ms), so the forecast here counts its days
 * from the same time the machine's card does. When the page's day has begun
 * since that read, as it has for a machine that has been away for days or just
 * after midnight, it is the start of the day (`today`) instead, so "yesterday"
 * and the idle weeks are never counted from the past.
 */
export const decideStorageNow = (hourPointsReadAt: number, today: Date): Date =>
  new Date(Math.max(hourPointsReadAt, today.getTime()));

/**
 * Reads what the Storage section of the machine `runnerId` draws, before the
 * page renders: the runner's negotiated capabilities, the Fleet page's hour
 * points for the forecast, the shell's workspaces, and, when the runner can
 * measure storage, the Threads of the idle workspaces. `timezone` is the zone
 * of the page's days (see `decideStorageNow`).
 *
 * The Threads are read last and with `prefetchQuery`, which never fails: the
 * section draws a failed read as a line with a Retry.
 */
export const loadMachineStorage = async (
  queryClient: QueryClient,
  client: HerculeClient,
  runnerId: string,
  timezone: string,
): Promise<void> => {
  const [capabilities, hours, workspaces] = await Promise.all([
    queryClient.ensureQueryData(negotiatedCapabilitiesQuery(client, runnerId)),
    queryClient.ensureQueryData(runnerMetricsQuery(client, FLEET_HOUR_METRICS_SCOPE)),
    queryClient.ensureQueryData(workspacesQuery(client)),
  ]);
  if (!canMeasureStorage(capabilities)) return;
  const now = new Date();
  const today = computeDayStart(now, timezone) ?? now;
  const candidateIds = listCleanupCandidateIds(
    workspaces,
    runnerId,
    decideStorageNow(hours.readAt, today),
  );
  if (candidateIds.length === 0) return;
  await queryClient.prefetchQuery(cleanupThreadsQuery(client, runnerId, candidateIds));
};
