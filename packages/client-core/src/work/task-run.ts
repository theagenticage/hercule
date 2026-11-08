/**
 * The words and the shape of one run row of the details pane: the run's
 * workflow, a mark for how it went, a quiet word for where it is, and whether
 * the row offers Stop.
 */
import type { TrackingDetailRun } from "@hercule/contract";
import { isRunLive } from "../run-display";
import { dropClosingFullStops } from "../text";
import { shortenTitle } from "./card-title";

/**
 * The shape and tone of a run's mark. The names are those of the desktop's
 * `StatusShape`: a dashed ring for a run that has not started, a half-filled
 * ring while it goes, a check when it completed, a cross when it failed, and
 * a dash for one that was stopped.
 */
export interface TaskRunMark {
  readonly shape: "dashed" | "half" | "check" | "cross" | "hold";
  readonly tone: "quiet" | "good" | "bad";
}

/** One run row of the details pane. */
export interface TaskRunRow {
  readonly id: string;
  /** The workflow's name as it was when the run started. */
  readonly label: string;
  readonly mark: TaskRunMark;
  /** The one word to show beside the label: where the run is, or how it ended. */
  readonly state: string;
  /** Whether the row offers Stop: only a run that is pending or running does. */
  readonly canStop: boolean;
}

/**
 * Returns the mark and the word for a run's status. A running run that waits
 * for a signal (it has no step to run) reads "Waiting", not "Running".
 */
const describeRunState = (run: TrackingDetailRun): Pick<TaskRunRow, "mark" | "state"> => {
  switch (run.status) {
    case "pending":
      return { mark: { shape: "dashed", tone: "quiet" }, state: "Starting" };
    case "running":
      return {
        mark: { shape: "half", tone: "quiet" },
        state: run.awaitedSignalIds.length > 0 ? "Waiting" : "Running",
      };
    case "completed":
      return { mark: { shape: "check", tone: "good" }, state: "Done" };
    case "failed":
      return { mark: { shape: "cross", tone: "bad" }, state: "Failed" };
    case "cancelled":
      return { mark: { shape: "hold", tone: "quiet" }, state: "Stopped" };
  }
};

/** Returns the row of one run of the details pane. */
export const buildTaskRunRow = (run: TrackingDetailRun): TaskRunRow => ({
  id: run.id,
  label: run.workflowName,
  canStop: isRunLive(run.status),
  ...describeRunState(run),
});

/**
 * Returns what the undo line says after Stop was accepted: `Asked "Review PR"
 * to stop.` It claims no more than that: the run may take a moment to stop. A
 * long workflow name is cut.
 */
export const describeRunStopRequested = (workflowName: string): string =>
  `Asked "${shortenTitle(workflowName)}" to stop.`;

/** Returns what the undo line says when Stop was refused, with the reason the controller gave. */
export const describeRunStopRefused = (workflowName: string, reason: string): string =>
  `Could not stop "${shortenTitle(workflowName)}": ${dropClosingFullStops(reason)}.`;
