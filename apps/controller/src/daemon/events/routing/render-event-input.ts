/**
 * Renders a matched event as the text of a session input.
 *
 * The text is the only part of a delivery that a person or an agent reads, so
 * it has its own module. It is one line that describes the event, then the
 * payload as JSON, so the agent can act on it without another call.
 */
import type { Event } from "@hercule/contract";

/** Returns the payload's `subject.title`, or undefined when it has none. */
const readSubjectTitle = (payload: Readonly<Record<string, unknown>>): string | undefined => {
  const subject: unknown = payload["subject"];
  if (typeof subject !== "object" || subject === null) return undefined;
  const title: unknown = (subject as Record<string, unknown>)["title"];
  return typeof title === "string" && title !== "" ? title : undefined;
};

/**
 * Renders an event as input text: a line with the kind, the subject title and
 * the URL, joined by " - ", then the payload as a JSON code block.
 *
 * A field the event does not have is left out, not written as "undefined".
 * This text starts an agent's turn, and "undefined" would look like
 * information from the event.
 *
 * The JSON is compact. Indented JSON grows with the depth of every line, so a
 * deeply nested payload of a few kilobytes would become megabytes of input.
 */
export const renderEventInput = (event: Event): string => {
  const title = readSubjectTitle(event.payload);
  const line = [event.kind, title, event.url ?? undefined].filter(
    (part): part is string => part !== undefined,
  );
  return `${line.join(" - ")}\n\n\`\`\`json\n${JSON.stringify(event.payload)}\n\`\`\``;
};
