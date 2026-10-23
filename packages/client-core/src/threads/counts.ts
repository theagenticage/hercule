/**
 * Counts the sessions by pose, for the line at the foot of the sidebar, such
 * as "3 working · 2 waiting · 4 idle". Threads and Agents' sessions count.
 */
import type { Session } from "@hercule/contract";
import type { Pose } from "./pose";
import { isMarkedDone } from "./status";

/** How many sessions are working, waiting on the user, and idle. */
export interface ThreadCounts {
  readonly working: number;
  readonly waiting: number;
  readonly idle: number;
}

/**
 * Returns how many of `sessions` are `working`, `waiting` and `idle`, by their
 * pose in `poses`, keyed by session id. A group's sessions count one by one:
 * a row with one working and one idle Thread is both. These are not counted:
 *
 * - asleep and away sessions, so a fleet with hundreds of old threads reads
 *   "4 idle", not "470 idle";
 * - Threads marked Done, waiting or not, because the user put them away;
 * - a session `poses` holds no pose for.
 */
export const countThreadsByPose = (
  sessions: readonly Session[],
  poses: ReadonlyMap<string, Pose>,
): ThreadCounts => {
  const counts = { working: 0, waiting: 0, idle: 0 };
  for (const session of sessions) {
    if (isMarkedDone(session)) continue;
    const pose = poses.get(session.id);
    if (pose === "working" || pose === "waiting" || pose === "idle") counts[pose] += 1;
  }
  return counts;
};
