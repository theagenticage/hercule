import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { ConversationMessage } from "@hercule/contract";
import { Bubble, OwnerBubble } from "../bubble";
import { Markdown } from "../thread/markdown";

/**
 * One message of an assistant's conversation, drawn by who wrote it:
 *
 * - the owner's message is a bubble on the right, as in a thread;
 * - the assistant's reply is a bubble on the left, under the assistant's name;
 * - a notice is a centred, muted line, not a bubble, because the system wrote
 *   it rather than either side of the conversation.
 *
 * A reply or notice that a session produced links to that session, where the
 * work behind it, or the failure, can be read.
 *
 * Each row carries two data attributes:
 *
 * - `data-sender`, the sender's role, so a test can tell the three kinds apart
 *   without reading class names;
 * - `data-message-id`, so the screen can find a message's row again to keep
 *   the reader's place when earlier messages load above it.
 */
export function ConversationMessageView({
  message,
}: {
  readonly message: ConversationMessage;
}): JSX.Element {
  switch (message.senderRole) {
    case "owner":
      return (
        <div data-sender="owner" data-message-id={message.id} className="flex justify-end">
          <OwnerBubble text={message.text} />
        </div>
      );
    case "notice":
      return (
        <p
          data-sender="notice"
          data-message-id={message.id}
          className="flex flex-wrap items-baseline justify-center gap-x-2 text-center text-meta text-muted"
        >
          <span>{message.text}</span>
          <ShowWork sessionId={message.sessionId} />
        </p>
      );
    case "assistant":
      return (
        <div
          data-sender="assistant"
          data-message-id={message.id}
          className="flex flex-col items-start gap-1"
        >
          <span className="text-meta text-faint">{message.senderLabel}</span>
          <Bubble>
            <Markdown text={message.text} />
          </Bubble>
          <ShowWork sessionId={message.sessionId} />
        </div>
      );
  }
}

/** The link from a reply or a notice to the session that produced it. Nothing when there is none. */
function ShowWork({ sessionId }: { readonly sessionId: string | null }): JSX.Element | null {
  if (sessionId === null) return null;
  return (
    <Link
      to="/threads/$sessionId"
      params={{ sessionId }}
      className="rounded-control text-fine text-faint underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
    >
      Show work
    </Link>
  );
}
