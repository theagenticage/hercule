/**
 * Taking a Tracking row off Tracking: marking its Task done or cancelled, by
 * `E`, by a row's Mark done control, or by the pane's answers (spec 17
 * §Tracking).
 */
import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
  type TrackingRead,
} from "@hercule/client-core";
import { trackingQuery } from "../../app/queries";
import type { MoveToastState } from "./use-signal-moves";

/** The status a Task is set to when its row is taken off Tracking. */
export type TakeOffStatus = "done" | "cancelled";

/** What taking a row off needs to know of it: which Task, the title the toast names, and the status. */
interface TakeOff {
  readonly taskId: string;
  readonly title: string;
  readonly status: TakeOffStatus;
}

/** Takes Tracking rows off Tracking. */
export interface TakeOffTracking {
  /**
   * Sets the Task to `status`, which takes its row out of Tracking, then
   * calls `onTakenOff`. When that fails, it calls `onFailed` instead. Taking
   * off different Tasks runs side by side, each with its own toast. A second
   * request for a Task that is being taken off is ignored: the first one does
   * what it asks, and reports it.
   */
  readonly run: (takeOff: TakeOff, onTakenOff?: () => void, onFailed?: () => void) => void;
}

/** Returns the toast's words for a row taken off Tracking. */
const describeTakenOff = ({ title, status }: TakeOff): string =>
  status === "done" ? `Marked done: ${title}` : `Cancelled: ${title}`;

/** Returns the toast's words for a row that could not be taken off Tracking, with the reason. */
const describeTakeOffFailure = ({ title, status }: TakeOff, reason: string): string =>
  status === "done"
    ? `Couldn't mark ${title} done: ${reason}`
    : `Couldn't cancel ${title}: ${reason}`;

/**
 * Returns the function that takes a Tracking row off Tracking by setting its
 * Task `done` or `cancelled` (`task.update`). The row leaves Tracking at once,
 * without waiting for the read the controller's `task` push starts, and
 * `toast` says what happened. A failed request shows its error in the toast's
 * place and the row stays where it was.
 */
export const useTakeOffTracking = (
  client: HerculeClient,
  toast: MoveToastState,
): TakeOffTracking => {
  const queryClient = useQueryClient();
  const pendingTaskIds = useRef(new Set<string>());
  // The options of the mutation, not the call's callbacks, run for every
  // request, also when several are under way at once.
  const takeOff = useMutation({
    mutationFn: ({ taskId, status }: TakeOff) =>
      client.task.update({ params: { id: taskId }, payload: { status } }),
    onSuccess: (_task, variables) => {
      const { taskId } = variables;
      queryClient.setQueryData<TrackingRead>(
        trackingQuery(client).queryKey,
        (read) => read && { ...read, tasks: read.tasks.filter((task) => task.taskId !== taskId) },
      );
      invalidateWithoutCancelling(queryClient, queryKeys.tasks());
      invalidateWithoutCancelling(queryClient, queryKeys.task(taskId));
      invalidateWithoutCancelling(queryClient, queryKeys.tracking());
      toast.show(describeTakenOff(variables), false);
    },
    onError: (error, variables) => {
      toast.show(describeTakeOffFailure(variables, readErrorMessage(error)), true);
    },
  });
  return {
    run: (input, onTakenOff, onFailed) => {
      if (pendingTaskIds.current.has(input.taskId)) return;
      pendingTaskIds.current.add(input.taskId);
      takeOff.mutateAsync(input).then(
        () => {
          pendingTaskIds.current.delete(input.taskId);
          onTakenOff?.();
        },
        () => {
          pendingTaskIds.current.delete(input.taskId);
          onFailed?.();
        },
      );
    },
  };
};
