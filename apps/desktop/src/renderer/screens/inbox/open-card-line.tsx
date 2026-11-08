import { useId, useLayoutEffect, useRef, useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  buildSignalAnswers,
  invalidateWithoutCancelling,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import { DONE_ACTION_ID, type Signal } from "@hercule/contract";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { useAnswerSignal, type AnswerFailure } from "../../app/use-answer-signal";
import { signalQuery } from "../../app/queries";
import { SignalAnswers } from "../desk";

/**
 * Returns the key the Inbox's open card shows beside an answer: none. The
 * Inbox's own keys (`T` takes the card on, `E` dismisses it) must not look like
 * keys of an answer, and Return never answers.
 */
const readNoKey = (): null => null;

/** Marks `signal` done with `signal.markDone`, and reads it and the signal lists again when that works. */
const useMarkSignalDone = (
  client: HerculeClient,
  signal: Signal,
  onFailed: (failure: AnswerFailure) => void,
) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.signal.markDone({ payload: { signalIds: [signal.id] } }),
    onSuccess: () => {
      invalidateWithoutCancelling(queryClient, queryKeys.signal(signal.id));
      invalidateWithoutCancelling(queryClient, queryKeys.signals());
    },
    onError: (error) => {
      onFailed({ actionId: DONE_ACTION_ID, message: readErrorMessage(error) });
    },
  });
};

/**
 * Renders the answers of an open signal under its line: its Bound Actions
 * with their describe lines, and Mark done. An answer goes through
 * `signal.act`, Mark done through `signal.markDone`, and each ends only this
 * signal. Hand to an agent is left out: it stays on Intake.
 */
function OpenCardAnswers({
  client,
  signal,
  platform,
}: {
  readonly client: HerculeClient;
  readonly signal: Signal;
  readonly platform: DesktopPlatform;
}): JSX.Element | null {
  const idPrefix = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [openReplyId, setOpenReplyId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [doneFailure, setDoneFailure] = useState<AnswerFailure | null>(null);
  const { act, failure } = useAnswerSignal(client, signal, {
    onStart: () => {
      setDoneFailure(null);
    },
  });
  const markDone = useMarkSignalDone(client, signal, setDoneFailure);

  // A Reply box opens with the cursor in it: the user pressed its row to write.
  useLayoutEffect(() => {
    if (openReplyId === null) return;
    rootRef.current
      ?.querySelector<HTMLTextAreaElement>(`[data-compose-for="${CSS.escape(openReplyId)}"]`)
      ?.focus();
  }, [openReplyId]);

  const answers = buildSignalAnswers(signal).filter((answer) => answer.workflowId === null);
  if (signal.status !== "open" || answers.length === 0) return null;
  return (
    <div ref={rootRef} className="open-card-answers">
      <SignalAnswers
        answers={answers}
        openReplyId={openReplyId}
        drafts={drafts}
        locked={act.isPending || markDone.isPending}
        failure={doneFailure ?? failure}
        idPrefix={idPrefix}
        shortcutFor={readNoKey}
        platform={platform}
        onOpenReply={setOpenReplyId}
        onDraftChange={(actionId, text) => {
          setDrafts((current) => ({ ...current, [actionId]: text }));
        }}
        onAct={(actionId, text) => {
          if (actionId === DONE_ACTION_ID) {
            setDoneFailure(null);
            markDone.mutate();
          } else act.mutate(text === undefined ? { actionId } : { actionId, text });
        }}
      />
    </div>
  );
}

/**
 * Renders what an opened line of the timeline shows: the signal's answers,
 * read with `signal.read` alone, so a card with fifty lines reads one signal.
 * Until the read answers it says so, and a read that fails says why.
 * Orchestrating: it owns this read and the answers' mutations.
 */
export function OpenCardLine({
  client,
  signalId,
  platform,
}: {
  readonly client: HerculeClient;
  readonly signalId: string;
  readonly platform: DesktopPlatform;
}): JSX.Element {
  const read = useQuery(signalQuery(client, signalId));
  if (read.data === undefined) {
    return (
      <p className="open-card-line-note">
        {read.isError ? `Could not read this signal. ${readErrorMessage(read.error)}` : "Reading…"}
      </p>
    );
  }
  return <OpenCardAnswers client={client} signal={read.data} platform={platform} />;
}
