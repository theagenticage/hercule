/**
 * Sends an answer to a signal (`signal.act`) for the two places that give one
 * outside a mutation hook: the Inbox's pane (an answer that is sent at once)
 * and the pending intents (an answer that was held first).
 */
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import type { Signal } from "@hercule/contract";

/** One answer of a signal: the action, and the words typed in its reply box when it has one. */
export interface SignalAnswerRequest {
  readonly signalId: string;
  readonly actionId: string;
  readonly text?: string | undefined;
}

/**
 * Sends the answer `request` and returns the signal the controller gives back.
 * An answer that worked writes that signal, now resolved, into the signal's
 * cache while `isCurrent()` holds, so the pane stops offering its answers at
 * once. It reads no list: the answer writes an audit entry on the `signal`
 * topic, and the controller's push reads the Inbox and the open thing again.
 * Rejects when the controller refuses the answer or cannot be reached.
 */
export const actOnSignal = async (
  client: HerculeClient,
  queryClient: QueryClient,
  isCurrent: () => boolean,
  request: SignalAnswerRequest,
): Promise<Signal> => {
  const acted = await client.signal.act({
    params: { id: request.signalId },
    payload:
      request.text === undefined
        ? { actionId: request.actionId }
        : { actionId: request.actionId, text: request.text },
  });
  if (isCurrent()) queryClient.setQueryData(queryKeys.signal(request.signalId), acted);
  return acted;
};
