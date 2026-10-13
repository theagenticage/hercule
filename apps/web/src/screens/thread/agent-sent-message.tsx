import type { JSX, ReactNode } from "react";
import { ActorLink } from "../actor-link";
import { useSenderReading } from "./use-sender-reading";

/**
 * Draws a message another session's agent sent, with a line under it that
 * reads "Sent by" and the sender's name as a link to the sender, then
 * `note` after a "·" when there is one: "steered" for a message steered into
 * the running turn, "sending…" for one still on its way into the session.
 * The message's accessible name names the sender too, so a screen reader
 * never takes it for the owner's.
 *
 * While the sender is still being read, the sender is left out of the line
 * rather than filled with a name that may be wrong, and the line keeps its
 * height, so the transcript does not move when the name arrives. The message
 * is not a named group until then either, because a group with no name tells
 * a screen reader nothing.
 */
export function AgentSentMessage({
  senderSessionId,
  note,
  children,
}: {
  readonly senderSessionId: string;
  readonly note: string | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  const sender = useSenderReading(senderSessionId);
  return (
    <div
      role={sender === "loading" ? undefined : "group"}
      aria-label={sender === "loading" ? undefined : `Message from ${sender.label}`}
      className="flex flex-col items-end gap-1"
    >
      {children}
      <p className="text-meta text-faint">
        {sender === "loading" ? null : (
          <>
            Sent by <ActorLink actor={sender} plainClassName="text-faint" />
          </>
        )}
        {sender !== "loading" && note !== undefined ? " · " : null}
        {note}
        {/* An empty line has no height; the space gives it one. */}
        {sender === "loading" && note === undefined ? " " : null}
      </p>
    </div>
  );
}
