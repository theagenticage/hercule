import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { ConversationMessage } from "@hercule/contract";
import { OwnerBubble } from "../bubble";
import { Markdown } from "../thread/markdown";
import { TimeSeparator } from "../time-separator";

/**
 * One message of an assistant's conversation, drawn by who wrote it, in the
 * shape of the thread surface (spec 14 §The thread surface):
 *
 * - the owner's message is a bubble on the right, as in a thread, under a
 *   centred time separator when the screen passes one;
 * - the assistant's reply is prose at full width on the left, under the
 *   assistant's name, as an agent's prose is in a thread;
 * - a notice is a centred, muted line between two hairlines, not a bubble,
 *   because the system wrote it rather than either side of the conversation.
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
  stamp,
}: {
  readonly message: ConversationMessage;
  /** The time separator to show above the message; none when undefined. */
  readonly stamp?: string | undefined;
}): JSX.Element {
  switch (message.senderRole) {
    case "owner":
      return (
        <div data-sender="owner" data-message-id={message.id} className="flex flex-col gap-2">
          {stamp === undefined ? null : <TimeSeparator stamp={stamp} />}
          <div className="flex justify-end">
            <OwnerBubble text={message.text} />
          </div>
        </div>
      );
    case "notice":
      return (
        <div
          data-sender="notice"
          data-message-id={message.id}
          className="flex items-center justify-center gap-3 text-center text-meta text-muted"
        >
          <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-line" />
          <p className="flex max-w-[80%] flex-wrap items-baseline justify-center gap-x-2">
            <span>{message.text}</span>
            <ShowWork sessionId={message.sessionId} />
          </p>
          <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-line" />
        </div>
      );
    case "assistant":
      return (
        <div
          data-sender="assistant"
          data-message-id={message.id}
          className="flex flex-col items-start gap-1"
        >
          <span className="text-meta text-faint">{message.senderLabel}</span>
          <div className="w-full text-row text-ink">
            <Markdown text={message.text} />
          </div>
          <ShowWork sessionId={message.sessionId} />
        </div>
      );
  }
}

/**
 * Renders the link from a reply, a notice or the working row to the session
 * behind it. Renders nothing when there is no session.
 */
export function ShowWork({ sessionId }: { readonly sessionId: string | null }): JSX.Element | null {
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
