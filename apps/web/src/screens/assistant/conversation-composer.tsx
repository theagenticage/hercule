import { useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys, type HerculeClient, readErrorMessage } from "@hercule/client-core";
import { ComposerCard } from "../composer/composer-card";
import { SendButton } from "../composer/controls";
import { MessageBox } from "../composer/message-box";

/**
 * The conversation's composer: text only, addressed to the assistant. Enter
 * sends and Shift+Enter starts a new line. It is the thread composer's card
 * with only the send button in its row of controls, so the two cards have the
 * same height.
 *
 * A send stores the owner's message in the conversation, so on success the
 * message list is fetched again and the new bubble shows without waiting for
 * the live push. A refused send keeps the text, so nothing the user typed is
 * lost, and shows why above the card.
 */
export function ConversationComposer({
  client,
  conversationId,
  name,
  onSent,
}: {
  readonly client: HerculeClient;
  readonly conversationId: string;
  /** The assistant's name, for the placeholder. */
  readonly name: string;
  /** Called after a message is stored, so the screen can scroll down to it. */
  readonly onSent: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  // Set by `submit` before it calls `mutate`, and cleared when the send
  // settles. `send.isPending` reaches the render a tick after `mutate`, so a
  // second Enter in the same tick would still see it false; the ref is set at
  // once.
  const sendingRef = useRef(false);
  const send = useMutation({
    mutationFn: (message: string) =>
      client.conversation.send({ params: { id: conversationId }, payload: { text: message } }),
    onSuccess: async (_stored, sent) => {
      // The box is cleared only once the new bubble is in the list, so the
      // text never vanishes from both places at once.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.conversationMessages(conversationId),
      });
      // Text typed while the message was in flight is a new message, so the
      // box is cleared only while it still holds what was sent.
      setText((current) => (current === sent ? "" : current));
      onSent();
    },
    onSettled: () => {
      sendingRef.current = false;
    },
  });
  const canSend = !send.isPending && text.trim() !== "";
  const submit = (): void => {
    if (!canSend || sendingRef.current) return;
    sendingRef.current = true;
    send.mutate(text);
  };

  return (
    <div className="flex flex-col gap-2">
      {send.error === null ? null : (
        <p className="px-1 text-fine text-fail" role="alert">
          {readErrorMessage(send.error)}
        </p>
      )}
      <ComposerCard>
        <MessageBox
          value={text}
          placeholder={`Message ${name}`}
          disabled={false}
          onChange={setText}
          onSubmit={submit}
        />
        <div className="flex items-center justify-end">
          <SendButton tip="Send ⏎" disabled={!canSend} onSend={submit} />
        </div>
      </ComposerCard>
    </div>
  );
}
