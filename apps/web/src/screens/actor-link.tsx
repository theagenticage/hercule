import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { ActorReading, SenderReading } from "@hercule/client-core";
import { cn } from "@hercule/ui";

/**
 * The style of a link inside a line of text: the text in ink, underlined, and
 * outlined when it has keyboard focus. Shared with the other links such a line
 * holds, such as the links between a run and its re-runs, so they all look the
 * same.
 */
export const INLINE_LINK = cn(
  "rounded-control text-ink underline decoration-line underline-offset-[3px]",
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
);

/**
 * Renders who made a change: the actor's label, as a link to the session's
 * thread or the run's page when a session or a run made it, and plain text
 * otherwise. `plainClassName` styles the plain text, which the places that
 * show actors set in different inks.
 */
export function ActorLink({
  actor,
  plainClassName,
}: {
  readonly actor: ActorReading;
  readonly plainClassName: string;
}): JSX.Element {
  switch (actor.link.kind) {
    case "session":
      return (
        <Link
          to="/threads/$sessionId"
          params={{ sessionId: actor.link.sessionId }}
          className={INLINE_LINK}
        >
          {actor.label}
        </Link>
      );
    case "run":
      return (
        <Link to="/runs/$runId" params={{ runId: actor.link.runId }} className={INLINE_LINK}>
          {actor.label}
        </Link>
      );
    case "none":
      return <span className={plainClassName}>{actor.label}</span>;
  }
}

/**
 * Renders the name of the agent that sent a message into a thread: a link to
 * the sender's thread, or to its assistant's page when the sender answers an
 * assistant's conversation. A sender that could not be read is plain text in
 * `plainClassName`, written by `writeSenderName`.
 */
export function SenderName({
  sender,
  plainClassName,
}: {
  readonly sender: SenderReading;
  readonly plainClassName: string;
}): JSX.Element {
  switch (sender.link.kind) {
    case "thread":
      return (
        <Link
          to="/threads/$sessionId"
          params={{ sessionId: sender.link.sessionId }}
          className={INLINE_LINK}
        >
          {sender.name}
        </Link>
      );
    case "assistant":
      return (
        <Link
          to="/assistants/$assistantId"
          params={{ assistantId: sender.link.assistantId }}
          className={INLINE_LINK}
        >
          {sender.name}
        </Link>
      );
    case "none":
      return <span className={plainClassName}>{writeSenderName(sender)}</span>;
  }
}

/**
 * Returns the sender's name as it reads inside a sentence, such as "Sent by
 * Fix EU checkout" or "From another agent". A sender with a name of its own
 * keeps it as it is. The label of a sender that could not be read, "Another
 * agent", is written to stand alone, so inside a sentence it starts in lower
 * case.
 */
export const writeSenderName = (sender: SenderReading): string =>
  sender.link.kind === "none"
    ? sender.name.charAt(0).toLowerCase() + sender.name.slice(1)
    : sender.name;
