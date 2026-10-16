import { useState, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { chooseWakeLabel, type QuietRun } from "@hercule/client-core";
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
 * A reply to a Scheduled Wake that is not quiet carries "Heartbeat" or
 * "Reminder" in its meta line, as `chooseWakeLabel` says. Quiet
 * heartbeat replies are drawn by `QuietRunView`, many to a line.
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
      const wakeLabel = chooseWakeLabel(message);
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
            {wakeLabel === undefined
              ? message.senderLabel
              : `${message.senderLabel} · ${wakeLabel}`}
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

/** A faint dot between the parts of a muted line. */
function Dot(): JSX.Element {
  return (
    <span aria-hidden="true" className="text-faint">
      ·
    </span>
  );
}

/**
 * Renders a run of quiet heartbeat replies as one muted line: the summary,
 * then the times it covers in the mono face. The line stays one line.
 *
 * - A single reply with nothing to add ends with its "Show work" link on the
 *   same line.
 * - A run of several replies, or a reply with a note, is a button that
 *   unfolds one row per reply under the line: the time, a "Show work" link,
 *   and the note when the assistant wrote one.
 *
 * The line is inset by the button's own padding, so its words line up with
 * the prose of the replies around it. `stamp` is the day to show above the
 * line when it starts a new day, as `groupQuietReplies` decides. The row
 * carries `data-message-id` of the run's first reply, so the screen can keep
 * the reader's place when earlier messages load above it.
 */
export function QuietRunView({
  run,
  stamp,
}: {
  readonly run: QuietRun;
  readonly stamp?: string | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [only] = run.beats;
  const canUnfold = run.beats.length > 1 || only?.note !== null;
  const line = (
    <>
      <span>{run.summary}</span>
      {run.span === undefined ? null : (
        <>
          <Dot />
          <span className="font-mono tabular-nums text-faint">{run.span}</span>
        </>
      )}
    </>
  );
  return (
    <div
      data-sender="assistant"
      data-message-id={only?.id}
      data-quiet="true"
      className="flex flex-col items-start gap-1"
    >
      {stamp === undefined ? null : (
        <div className="w-full pb-1">
          <TimeSeparator stamp={stamp} />
        </div>
      )}
      {canUnfold ? (
        <DisclosureButton
          className="-ml-2.5"
          open={open}
          onToggle={() => {
            setOpen((current) => !current);
          }}
        >
          {line}
        </DisclosureButton>
      ) : (
        <p className="flex items-center gap-2 py-1 text-fine text-muted">
          {line}
          {only?.sessionId == null ? null : (
            <>
              <Dot />
              <ShowWork sessionId={only.sessionId} />
            </>
          )}
        </p>
      )}
      {open ? (
        <ul className="flex w-full flex-col gap-2">
          {run.beats.map((beat) => (
            <li key={beat.id} className="flex flex-col gap-1">
              <p className="flex items-center gap-2 text-fine text-muted">
                {run.beats.length > 1 && beat.time !== undefined ? (
                  <>
                    <span className="font-mono tabular-nums text-faint">{beat.time}</span>
                    <Dot />
                  </>
                ) : null}
                <ShowWork sessionId={beat.sessionId} />
              </p>
              {beat.note === null ? null : (
                <div className="w-full text-row text-muted">
                  <Markdown text={beat.note} />
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
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
