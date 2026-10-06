/**
 * Sums up a session's subagents in one short phrase: the tally pill above
 * the composer and the footer of the Subagents surface.
 */
import type { SessionRequest, Subagent } from "@hercule/contract";
import { isSubagentWaiting } from "./describe";

/** The tally pill's mark and count, such as a working mark and "2 of 6 running". */
export interface SubagentTally {
  /**
   * `waiting` while a subagent waits on the user, as `isSubagentWaiting`
   * decides, `working` while any subagent runs, and `done` once none runs.
   */
  readonly mark: "working" | "waiting" | "done";
  readonly count: string;
}

/** Counts the subagents that are running. */
const countRunning = (subagents: readonly Subagent[]): number =>
  subagents.filter((subagent) => subagent.status === "running").length;

/**
 * Returns the tally pill's mark and count. The count reads "2 of 6 running"
 * while any subagent runs, and only how many there are, such as "6", once
 * none runs. `openRequests` are the session's open Requests.
 */
export const describeSubagentTally = (
  subagents: readonly Subagent[],
  openRequests: readonly SessionRequest[],
): SubagentTally => {
  const running = countRunning(subagents);
  const count =
    running === 0
      ? String(subagents.length)
      : `${String(running)} of ${String(subagents.length)} running`;
  if (subagents.some((subagent) => isSubagentWaiting(subagent, openRequests))) {
    return { mark: "waiting", count };
  }
  return { mark: running === 0 ? "done" : "working", count };
};

/**
 * Returns how many subagents run and how many have ended, such as
 * "2 running · 4 settled". A count of zero is left out, so the phrase is
 * empty when there are no subagents.
 */
export const summarizeSubagents = (subagents: readonly Subagent[]): string => {
  const running = countRunning(subagents);
  const settled = subagents.length - running;
  const segments: string[] = [];
  if (running > 0) segments.push(`${String(running)} running`);
  if (settled > 0) segments.push(`${String(settled)} settled`);
  return segments.join(" · ");
};
