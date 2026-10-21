/**
 * Re-running the newest run of a Tracking row's Task, which the pane's Try
 * again answer does (spec 17 §Tracking).
 *
 * The state of the re-runs is the requests themselves, kept in the query
 * client's mutation cache, not in a component. A component forgets them: the
 * pane is rebuilt each time the selection moves, and the whole Intake screen
 * is rebuilt when the user leaves it and comes back. A rebuilt screen that
 * forgot a re-run still starting would let a second press start a second run.
 * And the keys that take a row off Tracking live in the screen: closing a Task
 * while its re-run starts would leave the starting run on a closed Task.
 */
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import type { Mutation } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import type { TrackingTask } from "@hercule/contract";

/** The key every re-run of a Tracking row runs under, so the screen can find them. */
const TRACKING_RERUN_KEY = ["tracking-rerun"];

/**
 * How long a finished re-run stays in the mutation cache. The app's default
 * for mutations is to drop them as soon as no component watches them, which
 * would end the lock the moment the screen is left. An accepted re-run is long
 * in Tracking's read by this time, so the lock has ended by itself.
 */
const FINISHED_RERUN_KEPT_MS = 5 * 60 * 1000;

/** What a re-run request asks for: the run to re-run, of the Task it belongs to. */
interface RerunRequest {
  readonly taskId: string;
  readonly runId: string;
}

/** A re-run request and how far it got. */
interface RerunState extends RerunRequest {
  readonly status: "idle" | "pending" | "success" | "error";
  /** The controller's refusal, set only when `status` is `error`. */
  readonly error: unknown;
  /** When the request was sent, in milliseconds. Orders the re-runs of one Task. */
  readonly submittedAt: number;
}

/**
 * Returns the state of a re-run request, as the mutation cache holds it. Every
 * mutation under `TRACKING_RERUN_KEY` is made by `start`, so its variables are
 * a `RerunRequest`.
 */
const readRerunState = (mutation: Mutation): RerunState => ({
  ...(mutation.state.variables as RerunRequest),
  status: mutation.state.status,
  error: mutation.state.error,
  submittedAt: mutation.state.submittedAt,
});

/**
 * Returns whether one of `states` is a re-run of the Task `taskId` that is
 * starting: its request is sending, or it was accepted for the run `runId` and
 * Tracking's read still has that run as the Task's newest. A re-run ends when
 * the read has a newer run. The accepted request refreshes Tracking's read, so
 * the read always catches up.
 */
const isRerunStarting = (
  states: ReadonlyArray<RerunState>,
  taskId: string,
  runId: string,
): boolean =>
  states.some(
    (state) =>
      state.taskId === taskId &&
      (state.status === "pending" || (state.status === "success" && state.runId === runId)),
  );

/** Re-runs the newest run of Tracking rows' Tasks. */
export interface RerunTracking {
  /**
   * Re-runs the run `runId`, the newest run of the Task `taskId`, with no
   * `mode`, so the workflow runs as it is stored now and the new run keeps the
   * Task. A request for a Task whose re-run is starting is ignored: a second
   * one would start a second run. Re-runs of different Tasks run side by side.
   */
  readonly start: (taskId: string, runId: string) => void;
  /**
   * Returns whether a re-run of `task` is starting (see `isRerunStarting`).
   * The lock holds as long as the app's query client, so it survives leaving
   * Intake and coming back.
   */
  readonly isStarting: (task: TrackingTask) => boolean;
  /**
   * Returns why the newest re-run of `task` was refused, or `null`. A refusal
   * shows only while the run it re-ran is still the Task's newest run, so it
   * never shows under a Try again for a later run.
   */
  readonly readRefusal: (task: TrackingTask) => string | null;
}

/** Returns the function that re-runs a Tracking row's run (`run.rerun`), and the questions the screen asks of the re-runs. */
export const useRerunTracking = (client: HerculeClient): RerunTracking => {
  const queryClient = useQueryClient();
  // Subscribes the screen, so it redraws as a re-run changes state.
  const states = useMutationState({
    filters: { mutationKey: TRACKING_RERUN_KEY },
    select: readRerunState,
  });
  // The options of the mutation, not the call's callbacks, run for every
  // request, also when several are under way at once, and after the screen
  // that sent the request is gone.
  const rerun = useMutation({
    mutationKey: TRACKING_RERUN_KEY,
    gcTime: FINISHED_RERUN_KEPT_MS,
    mutationFn: ({ runId }: RerunRequest) =>
      client.run.rerun({ params: { id: runId }, payload: {} }),
    onSuccess: () => {
      // The new run's `run` push refreshes Tracking too. This makes sure a
      // read that started after the re-run committed arrives, even if that
      // push is lost, so the lock above always ends.
      invalidateWithoutCancelling(queryClient, queryKeys.tracking());
    },
  });
  return {
    start: (taskId, runId) => {
      // Reads the mutation cache, not `states`: `mutate` adds the request to
      // the cache as pending before it awaits anything, but `states` is the
      // snapshot of the last draw, which two quick presses both read.
      const current = queryClient
        .getMutationCache()
        .findAll({ mutationKey: TRACKING_RERUN_KEY })
        .map(readRerunState);
      if (isRerunStarting(current, taskId, runId)) return;
      rerun.mutate({ taskId, runId });
    },
    isStarting: (task) => isRerunStarting(states, task.taskId, task.latestRun.id),
    readRefusal: (task) => {
      const newest = states
        .filter((state) => state.taskId === task.taskId)
        .reduce<RerunState | undefined>(
          (latest, state) =>
            latest === undefined || state.submittedAt > latest.submittedAt ? state : latest,
          undefined,
        );
      return newest?.status === "error" && newest.runId === task.latestRun.id
        ? readErrorMessage(newest.error)
        : null;
    },
  };
};
