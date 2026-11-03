import type { JSX } from "react";
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import type { MachineNeed } from "@hercule/client-core/fleet";
import { runnersQuery } from "../../../../app/queries";
import { buildRecordScope, keepSavedRecord } from "../../../../app/saved-record-field";

/**
 * Renders the Allow button of a machine whose sessions wait for a slot. It
 * sets the machine's session cap to `need.allow`, so every waiting session can
 * start (`runner.update`). A failed save leaves the cap as it was and shows the
 * controller's message under the machine's need line.
 *
 * - The button and the message are siblings of the need line, for its card or
 *   row to lay out. The message is an alert on a line of its own.
 * - The save shares the mutation scope of the machine's other saves (the
 *   settings rows and Stop new work), so an Allow followed by an edit of the
 *   same machine's cap reaches the controller in that order. The mutation
 *   cache holds the scope, not this component, so the order holds also when
 *   the user leaves the page while the Allow is saving.
 * - The button shows that it is saving for as long as the mutation cache holds
 *   a pending Allow of this machine, so a new card or row (after a switch
 *   between Grid and List) shows a save that is still running.
 * - A successful save puts the runner the controller returns in the cached
 *   list, so the card shows the new cap at once, and then reads the list
 *   again.
 */
export function AllowSessionsButton({
  runnerId,
  need,
}: {
  readonly runnerId: string;
  readonly need: Extract<MachineNeed, { kind: "waiting" }>;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const mutationKey = ["fleet", "allow-sessions", runnerId];
  const { mutate, error } = useMutation({
    mutationKey,
    scope: buildRecordScope(runnerId),
    mutationFn: (cap: number) =>
      client.runner.update({ params: { id: runnerId }, payload: { maxConcurrentSessions: cap } }),
    onSuccess: (saved) => keepSavedRecord(queryClient, runnersQuery(client).queryKey, saved),
  });
  const isSaving = useMutationState({ filters: { mutationKey, status: "pending" } }).length > 0;

  return (
    <>
      <button
        type="button"
        className="btn btn--sm fleet-attn-btn"
        title={need.allowHint}
        aria-disabled={isSaving || undefined}
        onClick={() => {
          if (!isSaving) mutate(need.allow);
        }}
      >
        {isSaving ? (
          <>
            <span className="spin" aria-hidden="true" /> Saving…
          </>
        ) : (
          `Allow ${String(need.allow)}`
        )}
      </button>
      {error !== null && (
        <span className="fleet-attn-err" role="alert">
          Could not allow {need.allow} sessions: {readErrorMessage(error)}
        </span>
      )}
    </>
  );
}
