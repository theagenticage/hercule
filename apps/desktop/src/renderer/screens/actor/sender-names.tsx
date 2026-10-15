/**
 * The names of the agents on the Discussions screen: a line of names beside a
 * shared file, and one agent's name as a link. The names come from
 * `useSenderReadings`, which never suspends and never fails: an agent whose
 * session cannot be read is "Another agent", so the Discussion still opens.
 */
import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { SenderReading } from "@hercule/client-core";
import { useSenderReadings } from "../thread/use-sender-reading";

/**
 * Renders the names of the agents of `sessionIds`, in order, as one line of
 * text separated by commas. Returns an empty string until every name has been
 * read, because a partial list would print names in the wrong places. The
 * line is one text node, because text split over several nodes can measure a
 * hair wider than the same text in one.
 */
export function SessionNames({ sessionIds }: { readonly sessionIds: readonly string[] }): string {
  const senders = useSenderReadings(sessionIds);
  if (senders === "loading") return "";
  return senders.map((sender) => sender.name).join(", ");
}

/**
 * Renders the name of `sender` as a link to its thread or assistant when it
 * has one, and as plain text when it has none.
 */
export function SenderNameLink({ sender }: { readonly sender: SenderReading }): JSX.Element {
  const { link } = sender;
  switch (link.kind) {
    case "session":
      return (
        <Link to="/threads/$sessionId" params={{ sessionId: link.sessionId }}>
          {sender.name}
        </Link>
      );
    case "assistant":
      return (
        <Link to="/assistants/$assistantId" params={{ assistantId: link.assistantId }}>
          {sender.name}
        </Link>
      );
    case "none":
      return <span>{sender.name}</span>;
  }
}
