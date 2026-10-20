/**
 * Marking a Tracking row done: the tick-off by `E` or by a row's Mark done
 * (spec 17 §Tracking).
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

/** What a tick-off needs to know of the row: which Task, and the title the toast names. */
interface TickOff {
  readonly taskId: string;
  readonly title: string;
}

/** Marks Tracking rows done. */
export interface TrackingTickOff {
  /**
   * Sets the Task `done`, which takes its row out of Tracking, then calls
   * `onDone`. When the tick-off fails, it calls `onFailed` instead. Tick-offs
   * of different Tasks run side by side, each with its own toast. A second
   * tick-off of a Task that is being marked done is ignored: the first one
   * does what it asks, and reports it.
   */
  readonly run: (tickOff: TickOff, onDone?: () => void, onFailed?: () => void) => void;
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
  const pendingTaskIds = useRef(new Set<string>());
  // The options of the mutation, not the call's callbacks, run for every
  // tick-off, also when several are under way at once.
  const tickOff = useMutation({
    mutationFn: ({ taskId }: TickOff) =>
      client.task.update({ params: { id: taskId }, payload: { status: "done" } }),
    onSuccess: (_task, { taskId, title }) => {
      queryClient.setQueryData<TrackingRead>(
        trackingQuery(client).queryKey,
        (read) => read && { ...read, rows: read.rows.filter((row) => row.task.taskId !== taskId) },
      );
      invalidateWithoutCancelling(queryClient, queryKeys.tasks());
      invalidateWithoutCancelling(queryClient, queryKeys.task(taskId));
      invalidateWithoutCancelling(queryClient, queryKeys.tracking());
      toast.show(`Marked done: ${title}`, false);
    },
    onError: (error, { title }) => {
      toast.show(`Couldn't mark ${title} done: ${readErrorMessage(error)}`, true);
    },
  });
  return {
    run: (input, onDone, onFailed) => {
      if (pendingTaskIds.current.has(input.taskId)) return;
      pendingTaskIds.current.add(input.taskId);
      tickOff.mutateAsync(input).then(
        () => {
          pendingTaskIds.current.delete(input.taskId);
          onDone?.();
        },
        () => {
          pendingTaskIds.current.delete(input.taskId);
          onFailed?.();
        },
      );
    },
  };
};
