/**
 * Re-running the newest run of a Tracking row's Task, which the pane's Try
 * again answer does (spec 17 §Tracking).
 *
 * The screen owns this state, not the pane, for two reasons. The pane is
 * rebuilt each time the selection moves, and a rebuilt pane would forget a
 * re-run that is still starting, so a second press would start a second run.
 * And the keys that take a row off Tracking live in the screen: closing a Task
 * while its re-run starts would leave the starting run on a closed Task.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import type { TrackingTask } from "@hercule/contract";

/** What the screen knows of a Task's last re-run request: which run it re-runs, and how far it got. */
interface RerunEntry {
  /** The run that is being re-run, which was the Task's newest run when the user pressed Try again. */
  readonly runId: string;
  readonly status: "sending" | "accepted" | "refused";
  /** Why the controller refused the request. Set only while `status` is `refused`. */
  readonly message?: string;
}

/** Re-runs the newest run of Tracking rows' Tasks. */
export interface RerunTracking {
  /**
   * Re-runs the run `runId` of the Task `taskId` with no `mode`, so the
   * workflow runs as it is stored now and the new run keeps the Task. A
   * request for a run whose re-run is sending, or was accepted, is ignored:
   * a second one would start a second run. Re-runs of different Tasks run
   * side by side.
   */
  readonly start: (taskId: string, runId: string) => void;
  /**
   * Returns whether a re-run of `task` is starting: its request is sending, or
   * it was accepted and Tracking's read still has the re-run run as the Task's
   * newest run. A re-run ends when the read has a newer run. The accepted
   * request refreshes Tracking's read, so the read always catches up.
   */
  readonly isStarting: (task: TrackingTask) => boolean;
  /**
   * Returns why the last re-run of `task` was refused, or `null`. A refusal
   * shows only while the run it re-ran is still the Task's newest run, so it
   * never shows under a Try again for a later run.
   */
  readonly readRefusal: (task: TrackingTask) => string | null;
}

/** Returns the function that re-runs a Tracking row's run (`run.rerun`), and the questions the screen asks of the re-runs in flight. */
export const useRerunTracking = (client: HerculeClient): RerunTracking => {
  const queryClient = useQueryClient();
  const [entries, setEntries] = useState<Readonly<Record<string, RerunEntry>>>({});
  const setEntry = (taskId: string, entry: RerunEntry): void => {
    setEntries((current) => ({ ...current, [taskId]: entry }));
  };
  // The options of the mutation, not the call's callbacks, run for every
  // request, also when several are under way at once.
  const rerun = useMutation({
    mutationFn: ({ runId }: { taskId: string; runId: string }) =>
      client.run.rerun({ params: { id: runId }, payload: {} }),
    onMutate: ({ taskId, runId }) => {
      setEntry(taskId, { runId, status: "sending" });
    },
    onSuccess: (_started, { taskId, runId }) => {
      setEntry(taskId, { runId, status: "accepted" });
      // The new run's `run` push refreshes Tracking too. This makes sure a
      // read that started after the re-run committed arrives, even if that
      // push is lost, so the entry above always ends.
      invalidateWithoutCancelling(queryClient, queryKeys.tracking());
    },
    onError: (error, { taskId, runId }) => {
      setEntry(taskId, { runId, status: "refused", message: readErrorMessage(error) });
    },
  });
  return {
    start: (taskId, runId) => {
      const entry = entries[taskId];
      if (entry?.status === "sending") return;
      if (entry?.status === "accepted" && entry.runId === runId) return;
      rerun.mutate({ taskId, runId });
    },
    isStarting: (task) => {
      const entry = entries[task.taskId];
      if (entry === undefined) return false;
      return (
        entry.status === "sending" ||
        (entry.status === "accepted" && entry.runId === task.latestRun.id)
      );
    },
    readRefusal: (task) => {
      const entry = entries[task.taskId];
      return entry?.status === "refused" && entry.runId === task.latestRun.id
        ? (entry.message ?? null)
        : null;
    },
  };
};
