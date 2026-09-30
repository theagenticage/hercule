/**
 * Counts the threads by pose, for the line at the foot of the sidebar, such
 * as "3 working · 2 waiting · 4 idle".
 */
import type { Pose } from "./pose";

/** How many threads are working, waiting on the user, and idle. */
export interface ThreadCounts {
  readonly working: number;
  readonly waiting: number;
  readonly idle: number;
}

/**
 * Returns how many of the poses are `working`, `waiting` and `idle`. Asleep and
 * away threads are not counted: a fleet with hundreds of old threads should
 * read "4 idle", not "470 idle".
 */
export const countThreadsByPose = (poses: Iterable<Pose>): ThreadCounts => {
  const counts = { working: 0, waiting: 0, idle: 0 };
  for (const pose of poses) {
    if (pose === "working" || pose === "waiting" || pose === "idle") counts[pose] += 1;
  }
  return counts;
};
