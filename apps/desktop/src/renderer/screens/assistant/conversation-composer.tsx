import { useSyncExternalStore, type JSX, type Ref } from "react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildRequestDock, isMutationRunning, readErrorMessage } from "@hercule/client-core";
import type { Assistant, Session } from "@hercule/contract";
import { buildAssistantDraftKey } from "../../app/pending-submissions";
import { storeSentMessage } from "../../app/queries";
import { useShownRequestId } from "../../app/request-drafts";
import type { Look } from "../../faces";
import { ComposerFrame } from "../session/composer-frame";
import { RequestDock } from "../session/dock";
import { SessionPermissionRequestDock } from "../session/permission-request-dock";
import { RequestPager } from "../session/request-pager";
import { useSendOnMenuCommand } from "../session/send-key";
import { MESSAGE_HISTORY_KEY, useComposerAnswer } from "../session/use-composer-answer";
import { useTypingGuard } from "../session/use-typing-guard";

/**
 * Renders the composer of `assistant`'s Conversation in a `ComposerFrame`,
 * floating over the bottom of the Conversation: the dock while the current
 * session waits on a Request, then the card with Send, or Stop while a turn
 * runs.
 *
 * While the dock shows a question the agent asked, the composer answers it
 * instead (`useComposerAnswer`): the field shows and edits the shown
 * question's own answer, and Send gives way to Previous and the step button,
 * with Stop beside them while a turn runs. The field takes text only. The
 * Message Draft is kept as it is and comes back when the Request closes. A
 * question does not take over while the user is typing a message: it waits
 * until they pause, send, or leave the field (`useTypingGuard`).
 *
 * ⏎ in the field, or Send, sends the message with `conversation.send`, also
 * while a turn runs: the controller then steers it into the turn. The
 * message shows in the Conversation once the controller has stored it, when
 * the send returns, and not before. Stop interrupts the current session's
 * turn.
 *
 * The text not sent yet is the assistant's Message Draft, kept in the
 * controller's `pendingSubmissions` under `buildAssistantDraftKey`, so it is
 * still there when the user comes back. A send that fails keeps the text,
 * and shows the error under the row.
 *
 * - `session` is the Conversation's current session, or `null` when none
 *   has started. Stop and the dock act on it.
 * - `look` is the assistant's look, which the dock's face is drawn in.
 * - `shrunk`, `onFocusChange`, `scrollConversationToBottom` and `ref` are
 *   the frame's: see `ComposerFrame`. `scrollConversationToBottom` is also
 *   called when a message is sent.
 */
export function ConversationComposer({
  assistant,
  session,
  look,
  shrunk,
  onFocusChange,
  scrollConversationToBottom,
  ref,
}: {
  readonly assistant: Assistant;
  readonly session: Session | null;
  readonly look: Look;
  readonly shrunk: boolean;
  readonly onFocusChange: (focused: boolean) => void;
  readonly scrollConversationToBottom: () => void;
  readonly ref?: Ref<HTMLDivElement>;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client, pendingSubmissions } = controller;
  const queryClient = useQueryClient();
  const conversationId = assistant.mainConversationId;
  const draftKey = buildAssistantDraftKey(assistant.id);
  const pending = useSyncExternalStore(pendingSubmissions.subscribe, () =>
    pendingSubmissions.read(draftKey),
  );
  // Keyed by the assistant, so a composer mounted again while its send is
  // still on the way finds it running and does not send the message twice.
  const sendKey = ["conversation-send", assistant.id];
  const sending = useIsMutating({ mutationKey: sendKey }) > 0;

  const send = useMutation({
    mutationKey: sendKey,
    mutationFn: (text: string) =>
      client.conversation.send({ params: { id: conversationId }, payload: { text } }),
    // Registered here rather than passed to `mutate`, so it also runs when
    // the user has left the Conversation before the send returns.
    onSuccess: async (message, text) => {
      // The draft is cleared once the message is in the cache, so the text
      // leaves the field in the same frame its bubble appears.
      await storeSentMessage(queryClient, client, conversationId, message);
      // A Conversation takes no images and no picks, so no images and the
      // draft's own empty picks are passed, which leaves them as they are.
      pendingSubmissions.clearSent(draftKey, {
        text,
        attachments: [],
        picks: pendingSubmissions.read(draftKey).picks,
      });
    },
    onError: (error) => {
      pendingSubmissions.recordFailure(draftKey, readErrorMessage(error));
    },
  });
  const interrupt = useMutation({
    mutationFn: (sessionId: string) =>
      client.session.interrupt({ params: { id: sessionId }, payload: {} }),
  });

  const [shownRequestId] = useShownRequestId(session?.id ?? "");
  const guard = useTypingGuard();
  // The Request the dock shows, which `ConversationRequestDock` decides the
  // same way. A Conversation starts no subagents.
  const shownRequest =
    session === null
      ? null
      : (buildRequestDock(session.openRequests, [], undefined, shownRequestId)?.request ?? null);
  // Without a session there is no Request, so the empty id is never read.
  const answer = useComposerAnswer(session?.id ?? "", shownRequest, guard.holding);

  const busy = session?.status === "busy";
  // A failed Stop is shown only while the turn it tried to stop runs: once
  // the turn ends, or another session takes over, it no longer applies.
  const stopFailed = interrupt.isError && busy && interrupt.variables === session.id;
  const stopFailure = stopFailed ? readErrorMessage(interrupt.error) : null;
  const error =
    answer === null ? (pending.failure ?? stopFailure) : (answer.failure ?? stopFailure);
  const canSend = pending.message.text.trim() !== "" && !sending;

  const submit = (): void => {
    // The user is done typing, whether or not the send goes through.
    guard.release();
    if (!canSend || isMutationRunning(queryClient, sendKey)) return;
    pendingSubmissions.clearFailure(draftKey);
    if (interrupt.isError) interrupt.reset();
    send.mutate(pending.message.text);
    scrollConversationToBottom();
  };
  const sendOrStep = answer === null ? submit : answer.step.onStep;
  useSendOnMenuCommand(sendOrStep);
  const stop = (): void => {
    if (session === null || interrupt.isPending) return;
    pendingSubmissions.clearFailure(draftKey);
    interrupt.mutate(session.id);
  };

  return (
    <ComposerFrame
      text={answer?.text ?? pending.message.text}
      onTextChange={
        answer?.onTextChange ??
        ((text) => {
          guard.holdAfterEdit();
          pendingSubmissions.writeText(draftKey, text);
        })
      }
      placeholder={answer?.placeholder ?? `Message ${assistant.name}…`}
      readOnly={answer?.locked === true}
      canSend={canSend}
      onSend={sendOrStep}
      stop={busy ? { stopping: interrupt.isPending, onStop: stop } : undefined}
      error={error}
      attachments={answer?.attachments}
      notice={answer === null ? null : answer.notice}
      step={answer?.step}
      historyKey={answer?.historyKey ?? MESSAGE_HISTORY_KEY}
      onFieldBlur={guard.release}
      onComposingChange={guard.reportComposing}
      above={
        session === null ? null : (
          <ConversationRequestDock session={session} look={look} messageDraftKey={draftKey} />
        )
      }
      shrunk={shrunk}
      onFocusChange={onFocusChange}
      scrollMessagesToBottom={scrollConversationToBottom}
      ref={ref}
    />
  );
}

/**
 * Renders the dock of the Request `session` shows, as a thread's page does:
 * the oldest open Request, unless the user paged to another. Renders nothing
 * while no Request is open.
 *
 * While several Requests are open, the pager line above the dock pages
 * between them. Unlike a thread's, the line names no asker: a
 * Conversation has one agent, and no page of a subagent to link to.
 *
 * While no Request is open, the dock shows the session's Permission
 * Requests instead, as a thread's does (`SessionPermissionRequestDock`).
 *
 * The composer below the dock answers a question (see `ConversationComposer`),
 * so the dock draws no field of its own for it.
 */
function ConversationRequestDock({
  session,
  look,
  messageDraftKey,
}: {
  readonly session: Session;
  readonly look: Look;
  /** The `pendingSubmissions` key of the Conversation's Message Draft, which the dock moves text a pick displaces to. */
  readonly messageDraftKey: string;
}): JSX.Element | null {
  const [shownRequestId, setShownRequestId] = useShownRequestId(session.id);
  // A Conversation's session starts no subagents, so every Request is its
  // own agent's, and the line above the card is drawn only to page.
  const dock = buildRequestDock(session.openRequests, [], undefined, shownRequestId);
  if (dock === null) return <SessionPermissionRequestDock session={session} look={look} />;
  return (
    <>
      {dock.showsAskerLine ? (
        <RequestPager sessionId={session.id} dock={dock} asker={null} onShow={setShownRequestId} />
      ) : null}
      <RequestDock
        key={dock.request.requestId}
        sessionId={session.id}
        look={look}
        request={dock.request}
        composerBelow
        messageDraftKey={messageDraftKey}
      />
    </>
  );
}
