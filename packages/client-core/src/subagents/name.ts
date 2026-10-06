/**
 * The name a screen shows for a subagent. It sits in a module of its own
 * because the desktop app's first screen names the subagent that asked a
 * thread's newest Request in that thread's notification, and needs nothing
 * else about subagents. The rest of their words load with the thread.
 */
import type { Subagent } from "@hercule/contract";

/**
 * Returns the name a screen shows for a subagent: its `description`, which
 * is the task name its parent gave it or the first line of its brief. Until
 * the controller has read either, it falls back to the subagent's agent
 * type, such as "Explore", and then to "Subagent".
 */
export const nameSubagent = (subagent: Subagent): string =>
  subagent.description ?? subagent.agentType ?? "Subagent";
