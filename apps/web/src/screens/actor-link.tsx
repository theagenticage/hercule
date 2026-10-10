import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { ActorReading } from "@hercule/client-core";
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
 * otherwise. It renders the agent that sent a message too, which a
 * `SenderReading` describes: a link to the sender's thread, or to its
 * assistant's page when the sender answers an assistant's conversation.
 * `plainClassName` styles the plain text, which the places that show actors
 * set in different inks.
 *
 * With `truncates`, a label too long for its place is cut to one line with an
 * ellipsis, and its whole text shows as a tooltip. The link itself is cut,
 * not an element around it, so its focus outline, drawn outside the link, is
 * never cut off with the text.
 */
export function ActorLink({
  actor,
  plainClassName,
  truncates = false,
}: {
  readonly actor: ActorReading;
  readonly plainClassName: string;
  readonly truncates?: boolean;
}): JSX.Element {
  const truncation = truncates ? { title: actor.label, className: "min-w-0 truncate" } : undefined;
  const linkClassName = cn(INLINE_LINK, truncation?.className);
  switch (actor.link.kind) {
    case "session":
      return (
        <Link
          to="/threads/$sessionId"
          params={{ sessionId: actor.link.sessionId }}
          title={truncation?.title}
          className={linkClassName}
        >
          {actor.label}
        </Link>
      );
    case "run":
      return (
        <Link
          to="/runs/$runId"
          params={{ runId: actor.link.runId }}
          title={truncation?.title}
          className={linkClassName}
        >
          {actor.label}
        </Link>
      );
    case "assistant":
      return (
        <Link
          to="/assistants/$assistantId"
          params={{ assistantId: actor.link.assistantId }}
          title={truncation?.title}
          className={linkClassName}
        >
          {actor.label}
        </Link>
      );
    case "none":
      return (
        <span title={truncation?.title} className={cn(plainClassName, truncation?.className)}>
          {actor.label}
        </span>
      );
  }
}
