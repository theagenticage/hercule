/**
 * Counts the threads by pose, for the line at the foot of the sidebar, such
 * as "3 working · 2 waiting · 4 idle".
 */
import type { Session } from "@hercule/contract";
import type { Pose } from "./pose";
import { isMarkedDone } from "./status";

/** How many threads are working, waiting on the user, and idle. */
export interface ThreadCounts {
  readonly working: number;
  readonly waiting: number;
  readonly idle: number;
}

/**
 * Returns how many of `threads` are `working`, `waiting` and `idle`, by their
 * pose in `poses`, keyed by session id. These threads are not counted:
 *
 * - asleep and away threads, so a fleet with hundreds of old threads reads
 *   "4 idle", not "470 idle";
 * - threads marked Done, waiting or not, because the user put them away;
 * - a thread `poses` holds no pose for.
 */
export const countThreadsByPose = (
  threads: readonly Session[],
  poses: ReadonlyMap<string, Pose>,
): ThreadCounts => {
  const counts = { working: 0, waiting: 0, idle: 0 };
  for (const session of threads) {
    if (isMarkedDone(session)) continue;
    const pose = poses.get(session.id);
    if (pose === "working" || pose === "waiting" || pose === "idle") counts[pose] += 1;
  }
  return counts;
};
