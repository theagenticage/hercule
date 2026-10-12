/**
 * A run's mark and the words for where its live runs are, as the workflow
 * list and the open workflow both draw them (spec 17 §Workflows): the
 * list's strip, the open workflow's run rows, and its timeline.
 *
 * This module is the subpath `@hercule/client-core/run-marks`, not part of
 * the index, so that it stays off the desktop app's first screen: it loads
 * in the chunk of the Workflows route.
 */
import type { RunStatus, RunSummary } from "@hercule/contract";
import type { Pose } from "./threads/pose";
import type { WaitingRunSession } from "./waiting";

/**
 * One run's state, as a strip, a run row and the timeline draw it. A run
 * waiting on the user, a running run, a completed run and a failed run each
 * have a mark. A cancelled run and a run that has not started yet have
 * none: a strip or the timeline draws a faint dot for them, and a run row
 * shows its words in the mark's place.
 */
export type RunMarkState =
  | Extract<Pose, "waiting" | "working" | "done" | "failed">
  | "cancelled"
  | "starting";

/**
 * Checks whether a run in `state` has a mark of its own. Returns false for
 * `cancelled` and `starting`, which are drawn without one.
 */
export const hasRunMark = (
  state: RunMarkState,
): state is Exclude<RunMarkState, "cancelled" | "starting"> =>
  state !== "cancelled" && state !== "starting";

/**
 * Where a run is, as its mark reads it: its status, and while it runs, the
 * steps that are active and the signals it waits for. A `RunSummary` has this
 * shape; a run's page builds it from the run's step records.
 */
export type RunPlace =
  | {
      readonly status: "running";
      readonly activeStepIds: ReadonlyArray<string>;
      readonly awaitedSignalIds: ReadonlyArray<string>;
    }
  | { readonly status: Exclude<RunStatus, "running"> };

/**
 * Checks whether a run has not started any step yet: it is pending, or
 * running with nothing active or awaited.
 */
const isRunStarting = (run: RunPlace): boolean =>
  run.status === "pending" ||
  (run.status === "running" && run.activeStepIds.length === 0 && run.awaitedSignalIds.length === 0);

/**
 * Returns a run's state as a strip, a run row and the timeline draw it.
 * `isWaiting` is whether a session of the run waits on the user.
 */
export const decideRunMarkState = (run: RunPlace, isWaiting: boolean): RunMarkState => {
  if (isWaiting) return "waiting";
  if (isRunStarting(run)) return "starting";
  if (run.status === "running") return "working";
  if (run.status === "completed") return "done";
  if (run.status === "failed") return "failed";
  return "cancelled";
};

/**
 * Returns the status text of a workflow that waits on the user, from one
 * session of its runs that waits: "review asks: Ship v2.4?", the step and
 * the question of its oldest open Request. For a session that belongs to no
 * step, the text is "Waiting on you".
 */
export const describeWaitingRunSession = (session: WaitingRunSession): string =>
  session.stepId === null ? "Waiting on you" : `${session.stepId} asks: ${session.question}`;

/**
 * Returns where a workflow's live runs are: "At review", "Waiting for
 * approved" while a run waits on a signal, or "Starting" before a run has
 * started a step. Several live runs are counted, and their places listed
 * once each: "2 runs · at fix, waiting for pr_merged".
 */
export const describeLiveRuns = (runs: ReadonlyArray<RunSummary>): string => {
  const places = new Set<string>();
  for (const run of runs) {
    if (isRunStarting(run)) places.add("starting");
    if (run.status !== "running") continue;
    for (const stepId of run.activeStepIds) places.add(`at ${stepId}`);
    for (const signalId of run.awaitedSignalIds) places.add(`waiting for ${signalId}`);
  }
  const where = [...places].join(", ");
  return runs.length > 1
    ? `${String(runs.length)} runs · ${where}`
    : where.charAt(0).toUpperCase() + where.slice(1);
};
