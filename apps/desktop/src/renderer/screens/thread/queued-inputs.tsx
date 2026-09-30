import type { JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { canSteerOrCancelQueuedInputs, queryKeys, readErrorMessage } from "@hercule/client-core";
import type { Input } from "@hercule/contract";
import { queuedInputsQuery, sessionQuery } from "../../app/queries";
import { ClockIcon } from "../../icons";
import "./queued-inputs.css";

/**
 * Renders the thread's queued inputs above the dock and the composer, one
 * row per input, oldest first, as the Bureau book's `.queued` draws them. The
 * first row runs next, and says so.
 *
 * Each row offers Steer and Cancel, except on a session that answers an
 * assistant's conversation: its queued inputs are the owner's messages,
 * which the conversation already shows as sent, and the controller refuses
 * to change them (see `canSteerOrCancelQueuedInputs`).
 *
 * The inputs are in the cache before the thread screen renders, so nothing
 * here waits in practice. Renders nothing when no input is queued.
 */
export function QueuedInputs({ sessionId }: { readonly sessionId: string }): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const inputs = useSuspenseQuery(queuedInputsQuery(client, sessionId)).data;
  const offersActions = canSteerOrCancelQueuedInputs(session);
  return (
    <>
      {inputs.map((input, index) => (
        <QueuedInputRow
          key={input.id}
          sessionId={sessionId}
          input={input}
          runsNext={index === 0}
          offersActions={offersActions}
        />
      ))}
    </>
  );
}

/**
 * Renders one queued input: the clock, its text on one line, how soon it
 * runs, and Steer and Cancel when `offersActions` is true. Below them, the
 * row shows why its last delivery failed, when one did, and why Steer or
 * Cancel failed, when one does.
 *
 * Steer delivers the input into the running turn now, rather than after it;
 * Cancel drops the input. Either one, once it succeeds, reads the queue
 * again, so the row leaves the list. Both are disabled while either one
 * runs.
 */
function QueuedInputRow({
  sessionId,
  input,
  runsNext,
  offersActions,
}: {
  readonly sessionId: string;
  readonly input: Input;
  readonly runsNext: boolean;
  readonly offersActions: boolean;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const queryClient = useQueryClient();
  const readQueueAgain = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: queryKeys.inputs(sessionId) });
  const address = { params: { id: sessionId, inputId: input.id } };
  const steer = useMutation({
    mutationFn: () => client.input.steer(address),
    onSuccess: readQueueAgain,
  });
  const cancel = useMutation({
    mutationFn: () => client.input.cancel(address),
    onSuccess: readQueueAgain,
  });
  const running = steer.isPending || cancel.isPending;
  const failure = steer.error ?? cancel.error;

  return (
    <div className="queued">
      <ClockIcon size={14} />
      <span className="queued-text" title={input.text}>
        {input.text}
      </span>
      <span className="faint">{runsNext ? "queued · runs next" : "queued"}</span>
      {offersActions ? (
        <>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            aria-disabled={running || undefined}
            onClick={() => {
              if (!running) steer.mutate();
            }}
          >
            Steer
          </button>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            aria-disabled={running || undefined}
            onClick={() => {
              if (!running) cancel.mutate();
            }}
          >
            Cancel
          </button>
        </>
      ) : null}
      {input.reason === null ? null : <span className="queued-note faint">{input.reason}</span>}
      {failure === null ? null : (
        <span className="queued-note queued-error" role="alert">
          {readErrorMessage(failure)}
        </span>
      )}
    </div>
  );
}
