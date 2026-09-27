import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { canSteerOrCancelQueuedInputs, queryKeys, type HerculeClient } from "@hercule/client-core";
import type { Input } from "@hercule/contract";
import { Button } from "@hercule/ui";
import { inputsQuery, sessionQuery } from "../../app/queries";
import { readErrorMessage } from "../save-status";

/**
 * The list of queued messages above the composer, each with Steer and Cancel.
 * The query returns the session's whole input history; this component shows
 * only the inputs still `queued`, because delivered or cancelled ones can no
 * longer be acted on.
 *
 * On a session that answers an assistant's conversation, the rows have no
 * Steer and no Cancel: each queued input is a message the conversation
 * already shows as the owner's, and the controller refuses to change it.
 */
export function QueuedInputs({
  client,
  sessionId,
}: {
  readonly client: HerculeClient;
  readonly sessionId: string;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const rows = useQuery(inputsQuery(client, sessionId)).data?.items ?? [];
  const queued = rows.filter((row) => row.status === "queued");

  const reread = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: queryKeys.inputs(sessionId) });

  if (queued.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {queued.map((row) => (
        <QueuedRow
          key={row.id}
          client={client}
          sessionId={sessionId}
          row={row}
          actionable={canSteerOrCancelQueuedInputs(session)}
          onDone={reread}
        />
      ))}
    </div>
  );
}

function QueuedRow({
  client,
  sessionId,
  row,
  actionable,
  onDone,
}: {
  readonly client: HerculeClient;
  readonly sessionId: string;
  readonly row: Input;
  /** Whether the row offers Steer and Cancel. */
  readonly actionable: boolean;
  readonly onDone: () => Promise<void>;
}): JSX.Element {
  const steer = useMutation({
    mutationFn: () => client.input.steer({ params: { id: sessionId, inputId: row.id } }),
    onSuccess: onDone,
  });
  const cancel = useMutation({
    mutationFn: () => client.input.cancel({ params: { id: sessionId, inputId: row.id } }),
    onSuccess: onDone,
  });
  const failure = steer.error ?? cancel.error;

  return (
    <div className="flex flex-col gap-1 rounded-control border border-line-soft bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-row text-ink">{row.text}</span>
        {actionable ? (
          <>
            <Button disabled={steer.isPending || cancel.isPending} onClick={() => steer.mutate()}>
              Steer
            </Button>
            <Button disabled={steer.isPending || cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel
            </Button>
          </>
        ) : null}
      </div>
      {row.reason === null ? null : <p className="text-fine text-faint">{row.reason}</p>}
      {failure === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {readErrorMessage(failure)}
        </p>
      )}
    </div>
  );
}
