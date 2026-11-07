/**
 * Stopping a live run of a Task from the details pane (`run.cancel`). It says
 * on the undo line that the run was asked to stop, with no Undo: a stopped run
 * cannot be started again where it was, and Try again is for runs that failed.
 * Nothing here navigates: the user stays on Work.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import { describeRunStopRefused, describeRunStopRequested } from "@hercule/client-core/work";
import { buildStillSignedInCheck } from "../../../app/still-signed-in";

/**
 * Returns the function that asks the run `runId` of the Task `taskId`, which
 * runs the workflow `workflowName`, to stop. `say` shows a line on the undo
 * line with no Undo. The Task's workspace of the run is kept, as Tracking's
 * Stop keeps it, so nothing the run made is lost.
 */
export const useStopRun = ({
  client,
  say,
}: {
  readonly client: HerculeClient;
  readonly say: (text: string) => void;
}): ((taskId: string, runId: string, workflowName: string) => void) => {
  const queryClient = useQueryClient();
  const stop = useMutation({
    mutationFn: ({
      runId,
    }: {
      taskId: string;
      runId: string;
      workflowName: string;
      isStillSignedIn: () => boolean;
    }) => client.run.cancel({ params: { id: runId }, payload: { keepWorkspace: true } }),
    onSuccess: (cancelled, { taskId, runId, workflowName, isStillSignedIn }) => {
      if (!isStillSignedIn()) return;
      queryClient.setQueryData(queryKeys.run(runId), cancelled);
      invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
      invalidateWithoutCancelling(queryClient, queryKeys.taskDetail(taskId));
      say(describeRunStopRequested(workflowName));
    },
    onError: (error, { workflowName, isStillSignedIn }) => {
      if (!isStillSignedIn()) return;
      say(describeRunStopRefused(workflowName, readErrorMessage(error)));
    },
  });
  return (taskId, runId, workflowName) => {
    stop.mutate({ taskId, runId, workflowName, isStillSignedIn: buildStillSignedInCheck(client) });
  };
};
