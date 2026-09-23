import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import type { Input } from "@hercule/contract";
import { Button } from "@hercule/ui";
import { inputsQuery } from "../../app/queries";
import { readErrorMessage } from "../save-status";

/**
 * The queued list above the composer: every `queued` row from a session's
 * input history, each with Steer and Cancel. A row a caller cannot
 * act on any more (delivered, cancelled) never reaches here - the query holds
 * the whole history, this filters to what is still waiting.
 */
export function QueuedInputs({
  client,
  sessionId,
}: {
  readonly client: HerculeClient;
  readonly sessionId: string;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const rows = useQuery(inputsQuery(client, sessionId)).data?.items ?? [];
  const queued = rows.filter((row) => row.status === "queued");

  const reread = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: queryKeys.inputs(sessionId) });

  if (queued.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {queued.map((row) => (
        <QueuedRow key={row.id} client={client} sessionId={sessionId} row={row} onDone={reread} />
      ))}
    </div>
  );
}

function QueuedRow({
  client,
  sessionId,
  row,
  onDone,
}: {
  readonly client: HerculeClient;
  readonly sessionId: string;
  readonly row: Input;
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
        <Button disabled={steer.isPending || cancel.isPending} onClick={() => steer.mutate()}>
          Steer
        </Button>
        <Button disabled={steer.isPending || cancel.isPending} onClick={() => cancel.mutate()}>
          Cancel
        </Button>
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
