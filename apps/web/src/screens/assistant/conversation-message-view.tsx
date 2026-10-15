import { useState, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { decideReplyPresentation } from "@hercule/client-core";
import type { ConversationMessage } from "@hercule/contract";
import { DisclosureButton } from "@hercule/ui";
import { MessageBubble } from "../bubble";
import { Markdown } from "../markdown";
import { TimeSeparator } from "../time-separator";

/**
 * Renders one message of an assistant's conversation, drawn by who wrote it,
 * in the same shape as a thread:
 *
 * - the owner's message is a bubble on the right, as in a thread, under a
 *   centred time separator when the screen passes one;
 * - the assistant's reply is prose at full width on the left, under the
 *   assistant's name, as an agent's prose is in a thread;
 * - a notice is a centred, muted line between two hairlines, not a bubble,
 *   because the system wrote it rather than either side of the conversation.
 *
 * A reply to a Scheduled Wake is drawn as `decideReplyPresentation` says: a
 * quiet heartbeat reply folds into one muted line, and any other reply to a
 * wake carries "Heartbeat" or "Reminder" in its meta line.
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
 *
 * Spec 14 §The thread surface owns the thread's shape.
 */
export function ConversationMessageView({
  message,
  stamp,
  time,
}: {
  readonly message: ConversationMessage;
  /** The time separator to show above the message; none when undefined. */
  readonly stamp?: string | undefined;
  /** The message's own time, shown on a quiet heartbeat line, which has no separator. */
  readonly time?: string | undefined;
}): JSX.Element {
  switch (message.senderRole) {
    case "owner":
      return (
        <div data-sender="owner" data-message-id={message.id} className="flex flex-col gap-2">
          {stamp === undefined ? null : <TimeSeparator stamp={stamp} />}
          <div className="flex justify-end">
            <MessageBubble text={message.text} />
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
    case "assistant": {
      const presentation = decideReplyPresentation(message);
      if (presentation.kind === "quiet") {
        return (
          <div data-sender="assistant" data-message-id={message.id} data-quiet="true">
            <QuietReply
              summary={presentation.summary}
              detail={presentation.detail}
              time={time}
              sessionId={message.sessionId}
            />
          </div>
        );
      }
      return (
        <div
          data-sender="assistant"
          data-message-id={message.id}
          className="flex flex-col items-start gap-1"
        >
          {stamp === undefined ? null : (
            // 4px under the separator, plus the 4px gap below it, make the
            // 8px the owner's messages keep between separator and bubble.
            <div className="w-full pb-1">
              <TimeSeparator stamp={stamp} />
            </div>
          )}
          <span className="text-meta text-faint">
            {presentation.kind === "labelled"
              ? `${message.senderLabel} · ${presentation.label}`
              : message.senderLabel}
          </span>
          <div className="w-full text-row text-ink">
            <Markdown text={message.text} />
          </div>
          <ShowWork sessionId={message.sessionId} />
        </div>
      );
    }
  }
}

/**
 * Renders a quiet heartbeat reply as one muted line: the summary, then the
 * reply's time in the mono face. When the assistant wrote something besides
 * `NO_REPLY`, the line is a button that unfolds that text under it. The line
 * is inset by the button's own padding, so its words line up with the prose
 * of the replies around it.
 */
function QuietReply({
  summary,
  detail,
  time,
  sessionId,
}: {
  readonly summary: string;
  readonly detail: string | null;
  readonly time: string | undefined;
  readonly sessionId: string | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const line = (
    <>
      <span>{summary}</span>
      {time === undefined ? null : (
        <span className="font-mono tabular-nums text-faint">{time}</span>
      )}
    </>
  );
  return (
    <div className="flex flex-col items-start gap-1">
      {detail === null ? (
        <p className="flex items-center gap-2 py-1 text-fine text-muted">{line}</p>
      ) : (
        <DisclosureButton
          className="-ml-2.5"
          open={open}
          onToggle={() => {
            setOpen((current) => !current);
          }}
        >
          {line}
        </DisclosureButton>
      )}
      {open && detail !== null ? (
        <div className="w-full text-row text-muted">
          <Markdown text={detail} />
        </div>
      ) : null}
      {open || detail === null ? <ShowWork sessionId={sessionId} /> : null}
    </div>
  );
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
