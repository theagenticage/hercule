/**
 * Marking a Tracking row done: the tick-off by `E` or by a row's Mark done
 * (spec 17 §Tracking).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import { trackedTasksQuery } from "../../app/queries";
import type { MoveToastState } from "./use-signal-moves";

/** What a tick-off needs to know of the row: which Task, and the title the toast names. */
interface TickOff {
  readonly taskId: string;
  readonly title: string;
}

/** Marks Tracking rows done. */
export interface TrackingTickOff {
  /**
   * Sets the Task `done`, which takes its row out of Tracking, then calls
   * `onDone`. Does nothing while another tick-off is being sent.
   */
  readonly run: (tickOff: TickOff, onDone?: () => void) => void;
}

/**
 * Returns the function that marks a Tracking row done by setting its Task
 * `done` (`task.update`). The row leaves Tracking at once, without waiting for
 * the read the controller's `task` push starts, and `toast` says what
 * happened. A failed tick-off shows its error in the toast's place and the row
 * stays where it was.
 */
export const useTrackingTickOff = (
  client: HerculeClient,
  toast: MoveToastState,
): TrackingTickOff => {
  const queryClient = useQueryClient();
  const tickOff = useMutation({
    mutationFn: ({ taskId }: TickOff) =>
      client.task.update({ params: { id: taskId }, payload: { status: "done" } }),
    onSuccess: (_task, { taskId, title }) => {
      queryClient.setQueryData(
        trackedTasksQuery(client).queryKey,
        (tasks) => tasks && tasks.filter((each) => each.id !== taskId),
      );
      invalidateWithoutCancelling(queryClient, queryKeys.tasks());
      invalidateWithoutCancelling(queryClient, queryKeys.task(taskId));
      toast.show(`Marked done: ${title}`, false);
    },
    onError: (error) => {
      toast.show(`Couldn't mark done: ${readErrorMessage(error)}`, true);
    },
  });
  return {
    run: (input, onDone) => {
      if (tickOff.isPending) return;
      tickOff.mutate(input, onDone === undefined ? undefined : { onSuccess: onDone });
    },
  };
};
