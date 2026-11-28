import type { RunnerMetrics } from "@hercule/contract";

/**
 * Checks whether a runner's free disk is below its disk limit. Equal is not
 * below, and a runner with no metrics yet (`null`) is not below.
 */
export const isDiskBelowLimit = (
  metrics: Pick<RunnerMetrics, "diskFreeBytes"> | null,
  limitBytes: number,
): boolean => metrics !== null && metrics.diskFreeBytes < limitBytes;
