import type { JSX } from "react";
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import type { MachineNeed } from "@hercule/client-core/fleet";
import { runnersQuery } from "../../../../app/queries";
import { buildRecordScope, keepSavedRecord } from "../../../../app/saved-record-field";

/** How long a finished Allow stays in the mutation cache, as Query's default `gcTime` for a query. */
const KEEP_ALLOW_MS = 5 * 60 * 1000;

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
 * - The mutation cache is the one source of truth for this machine's latest
 *   Allow. The button shows "Saving…" while that Allow is pending and the
 *   refusal when it failed, with the cap it asked for. A new card or row (after
 *   a switch between Grid and List) therefore shows a save that is still
 *   running, and a failure that was already shown. A later Allow replaces an
 *   earlier failure, because it is the latest.
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
  const { mutate } = useMutation({
    mutationKey,
    scope: buildRecordScope(runnerId),
    // The app's `gcTime` of 0 removes a mutation as soon as no component
    // observes it. A button drawn anew after a Grid/List switch has to find
    // this Allow still in the cache, to show that it is saving or why it failed.
    gcTime: KEEP_ALLOW_MS,
    mutationFn: (cap: number) =>
      client.runner.update({ params: { id: runnerId }, payload: { maxConcurrentSessions: cap } }),
    onSuccess: (saved) => keepSavedRecord(queryClient, runnersQuery(client).queryKey, saved),
  });
  const latestAllow = useMutationState({
    filters: { mutationKey },
    select: (mutation) => ({
      status: mutation.state.status,
      error: mutation.state.error,
      cap: mutation.state.variables as number,
    }),
  }).at(-1);
  const isSaving = latestAllow?.status === "pending";

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
      {latestAllow?.status === "error" && (
        <span className="fleet-attn-err" role="alert">
          Could not allow {latestAllow.cap} sessions: {readErrorMessage(latestAllow.error)}
        </span>
      )}
    </>
  );
}
