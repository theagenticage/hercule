/**
 * How a run's page draws where the run is at a node: the mark each
 * `NodeRunState` takes, and the tone a state lends its card's status line
 * and its bar on the step timeline. The graph, a node's card and the step
 * timeline all read them here, so the three never disagree.
 */
import type { NodeRunState } from "@hercule/client-core/graph-model";
import type { MarkState } from "../../marks";

/**
 * The mark of each state that has one. A trigger that fired takes the done
 * mark and one that listens the idle mark, as the Bureau book draws them.
 * A step the run has not reached, or not started, skipped or cancelled has
 * no mark, and neither has a trigger that stayed quiet.
 */
const NODE_RUN_MARKS: Partial<Record<NodeRunState, MarkState>> = {
  working: "working",
  waiting: "waiting",
  done: "done",
  failed: "failed",
  fired: "done",
  listening: "idle",
};

/** Returns the mark a node in `state` is drawn with, or `undefined` for a state with none. */
export const findNodeRunMark = (state: NodeRunState): MarkState | undefined =>
  NODE_RUN_MARKS[state];

/**
 * Returns the tone of a node in `state`: `you` while it waits on the user,
 * `fail` once it failed, and `undefined` for every other state, which keeps
 * the ink of the place it is drawn in.
 */
export const decideNodeRunTone = (state: NodeRunState): "you" | "fail" | undefined => {
  if (state === "waiting") return "you";
  if (state === "failed") return "fail";
  return undefined;
};
