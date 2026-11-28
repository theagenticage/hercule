import type { RunnerMetrics } from "@hercule/contract";

/**
 * Checks whether a runner's free disk is below its disk limit, which is when
 * the controller places no new session on it. Returns false when free disk
 * equals the limit, and false when the runner has not reported its metrics
 * yet (`null`): a missing report does not mean the disk is full.
 */
export const isDiskBelowLimit = (
  metrics: Pick<RunnerMetrics, "diskFreeBytes"> | null,
  limitBytes: number,
): boolean => metrics !== null && metrics.diskFreeBytes < limitBytes;
