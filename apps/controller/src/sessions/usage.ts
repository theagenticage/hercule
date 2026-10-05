/**
 * Adds up Token Usage across a session's processes (spec 06 section 6.6).
 *
 * A harness reports a cumulative snapshot: everything its current process has
 * used so far. A resumed session is a new process that counts from zero
 * again, so the snapshot alone would lose what earlier processes used. The
 * controller therefore stores two values per agent:
 *
 * - `usage`, the running total over the session's whole life;
 * - `usageProcess`, the last snapshot of the current process.
 *
 * Each snapshot replaces the current process's share of the total. The same
 * rule serves a session's own count and each subagent's.
 */
import type { Usage } from "@hercule/protocol";

/** One agent's stored Token Usage: the running total and the current process's last snapshot. */
export interface StoredUsage {
  readonly usage: Usage | undefined;
  readonly usageProcess: Usage | undefined;
}

/** The optional counts of `Usage`, which only some harnesses report. */
const OPTIONAL_COUNTS = ["cacheReadTokens", "cacheWriteTokens", "costUsd"] as const;

/**
 * Returns `total - process + snapshot` for one count. It is never below 0:
 * the total always includes the process's share, but cost is a fraction, and
 * floating point can leave a tiny negative where the exact answer is 0.
 */
const replaceProcessShare = (total: number, process: number, snapshot: number): number =>
  Math.max(0, total - process + snapshot);

/**
 * Applies one usage snapshot from the current process. Returns the new running
 * total, with the snapshot stored as the process's share.
 *
 * An optional count is in the result when the total or the snapshot has it,
 * so a count the harness never reported stays absent instead of reading 0.
 * A snapshot that leaves out an optional count the process reported before
 * keeps that count's earlier share: a cumulative count never goes down, so
 * the missing count is read as unchanged rather than as 0.
 */
export const addUsageSnapshot = (stored: StoredUsage, snapshot: Usage): StoredUsage => {
  const { usage, usageProcess } = stored;
  const optional: Partial<Record<(typeof OPTIONAL_COUNTS)[number], number>> = {};
  const share: Partial<Record<(typeof OPTIONAL_COUNTS)[number], number>> = {};
  for (const count of OPTIONAL_COUNTS) {
    const reported = snapshot[count] ?? usageProcess?.[count];
    if (reported !== undefined) share[count] = reported;
    if (usage?.[count] === undefined && reported === undefined) continue;
    optional[count] = replaceProcessShare(
      usage?.[count] ?? 0,
      usageProcess?.[count] ?? 0,
      reported ?? 0,
    );
  }
  return {
    usage: {
      inputTokens: replaceProcessShare(
        usage?.inputTokens ?? 0,
        usageProcess?.inputTokens ?? 0,
        snapshot.inputTokens,
      ),
      outputTokens: replaceProcessShare(
        usage?.outputTokens ?? 0,
        usageProcess?.outputTokens ?? 0,
        snapshot.outputTokens,
      ),
      ...optional,
    },
    usageProcess: {
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
      ...share,
    },
  };
};

/**
 * Returns an agent's stored Token Usage as a new process starts: the total is
 * kept and the process's share is cleared, because the new process counts
 * from zero again.
 */
export const clearProcessShare = (stored: StoredUsage): StoredUsage => ({
  usage: stored.usage,
  usageProcess: undefined,
});
