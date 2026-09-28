import type { JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { buildBoundActionRows, queryKeys, type HerculeClient } from "@hercule/client-core";
import type { Notification } from "@hercule/contract";
import { AnswerLedger } from "@hercule/ui";
import { readErrorMessage } from "../save-status";

/**
 * Renders the answers of an open decision as a ledger and takes the one the
 * user clicks with `notification.act`, which runs the answer's operation as
 * the user and resolves the decision.
 *
 * While the answer is being taken, every row is disabled. When it has been
 * taken, the notifications are read again, and the decision shows as
 * resolved. When taking it fails, the error shows under the ledger and the
 * notifications are read again too, because the failure may mean the
 * decision was resolved or withdrawn elsewhere. A decision that is still
 * open stays open, and the user can click again.
 */
export function DecisionLedger({
  client,
  notification,
}: {
  readonly client: HerculeClient;
  readonly notification: Notification;
}): JSX.Element {
  const queryClient = useQueryClient();
  const take = useMutation({
    mutationFn: (actionId: string) =>
      client.notification.act({ params: { id: notification.id }, payload: { actionId } }),
    // The `notification` live topic invalidates the same queries, but it may
    // arrive later than the response, so the screen does not wait for it.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.notifications() }),
  });
  // One answer per decision. The rows stay locked after a success until the
  // refetched notifications replace the open decision with the resolved one,
  // so a second click cannot send an answer the controller would reject.
  const rowsLocked = take.isPending || take.isSuccess;

  return (
    <div>
      <AnswerLedger
        rows={buildBoundActionRows(notification.actions)}
        disabled={rowsLocked}
        onSelect={(actionId) => take.mutate(actionId)}
      />
      {take.error === null ? null : (
        <p className="mt-1 text-fine text-fail" role="alert">
          {readErrorMessage(take.error)}
        </p>
      )}
    </div>
  );
}
