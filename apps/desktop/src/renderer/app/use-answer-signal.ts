/**
 * Answering a signal with one of its actions (`signal.act`), for the two
 * places that offer a signal's answers: Intake's pane and the Inbox's open
 * card. It holds the one answer being sent and the error of the answer that
 * failed, so the error is drawn under that answer's button.
 */
import { useState } from "react";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import type { Signal } from "@hercule/contract";
import { signalQuery } from "./queries";

/** An answer that failed, and why. */
export interface AnswerFailure {
  readonly actionId: string;
  readonly message: string;
}

/** What one answer sends: the action, and the text typed in its Reply box. */
export interface AnswerInput {
  readonly actionId: string;
  readonly text?: string;
}

/** What a caller does around an answer: before it is sent, after it worked, after it failed. */
export interface AnswerHooks {
  readonly onStart?: (actionId: string) => void;
  readonly onAnswered?: (actionId: string) => void;
  readonly onFailed?: (actionId: string) => void;
}

/** What `useAnswerSignal` returns. */
export interface SignalAnswering {
  /** Sends an answer with `act.mutate`. `act.isPending` is true while one is on its way. */
  readonly act: UseMutationResult<Signal, Error, AnswerInput>;
  /** The error of the answer that failed last, until the next answer starts. */
  readonly failure: AnswerFailure | null;
}

/**
 * Returns the way to answer `signal` with `act.mutate({ actionId, text })`.
 *
 * - An answer that works writes the signal the controller returns into the
 *   cache, so the signal shows as resolved at once. The lists need no read
 *   here: the answer writes an audit entry on the `signal` topic, and its
 *   live push reads every signal list, the Inbox and the open entity again.
 * - An answer that fails sets `failure`, which names the answer. The mutation
 *   itself drops its error when the next answer starts, so the failure is
 *   kept here.
 *
 * `hooks` lets the caller register the answer on its own page: before it is
 * sent, when it worked, and when it failed.
 */
export const useAnswerSignal = (
  client: HerculeClient,
  signal: Signal,
  hooks?: AnswerHooks,
): SignalAnswering => {
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<AnswerFailure | null>(null);
  const act = useMutation({
    mutationFn: (input: AnswerInput) =>
      client.signal.act({ params: { id: signal.id }, payload: input }),
    onMutate: ({ actionId }) => {
      setFailure(null);
      hooks?.onStart?.(actionId);
    },
    onSuccess: (acted, { actionId }) => {
      hooks?.onAnswered?.(actionId);
      queryClient.setQueryData(signalQuery(client, signal.id).queryKey, acted);
    },
    onError: (error, { actionId }) => {
      hooks?.onFailed?.(actionId);
      setFailure({ actionId, message: readErrorMessage(error) });
    },
  });
  return { act, failure };
};
