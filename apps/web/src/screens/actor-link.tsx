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
