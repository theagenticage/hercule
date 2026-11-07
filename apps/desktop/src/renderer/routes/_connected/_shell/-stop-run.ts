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
import type { AccountScope } from "../../../app/account-scope";

/**
 * Returns the function that, for the user of `scope`, asks the run `runId` of the Task `taskId`, which
 * runs the workflow `workflowName`, to stop. `say` shows a line on the undo
 * line with no Undo. The Task's workspace of the run is kept, as Tracking's
 * Stop keeps it, so nothing the run made is lost.
 */
export const useStopRun = ({
  client,
  scope,
  say,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly say: (text: string) => void;
}): ((taskId: string, runId: string, workflowName: string) => void) => {
  const queryClient = useQueryClient();
  const stop = useMutation({
    mutationFn: ({ runId }: { taskId: string; runId: string; workflowName: string }) =>
      client.run.cancel({ params: { id: runId }, payload: { keepWorkspace: true } }),
    onSuccess: (cancelled, { taskId, runId, workflowName }) => {
      if (!scope.isCurrent()) return;
      queryClient.setQueryData(queryKeys.run(runId), cancelled);
      invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
      invalidateWithoutCancelling(queryClient, queryKeys.taskDetail(taskId));
      say(describeRunStopRequested(workflowName));
    },
    onError: (error, { workflowName }) => {
      if (!scope.isCurrent()) return;
      say(describeRunStopRefused(workflowName, readErrorMessage(error)));
    },
  });
  return (taskId, runId, workflowName) => {
    stop.mutate({ taskId, runId, workflowName });
  };
};
