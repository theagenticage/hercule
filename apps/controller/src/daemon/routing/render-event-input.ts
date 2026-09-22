/**
 * What a matched event reads like as a session's input.
 *
 * The text is the only part of a delivery a person or an agent ever reads, so
 * it is written here on its own: one line saying what happened, then the
 * payload as JSON the agent can act on without another call.
 */
import type { Event } from "@hercule/contract";

/** The title the payload's subject carries, where it carries one. */
const readSubjectTitle = (payload: Readonly<Record<string, unknown>>): string | undefined => {
  const subject: unknown = payload["subject"];
  if (typeof subject !== "object" || subject === null) return undefined;
  const title: unknown = (subject as Record<string, unknown>)["title"];
  return typeof title === "string" && title !== "" ? title : undefined;
};

/**
 * A field the event does not carry is left out rather than written as the word
 * a template produces for a missing value. This text opens an agent's turn,
 * and a line reading "undefined" is a fact the agent did not learn from the
 * event.
 */
export const renderEventInput = (event: Event): string => {
  const title = readSubjectTitle(event.payload);
  const line = [event.kind, title, event.url ?? undefined].filter(
    (part): part is string => part !== undefined,
  );
  return `${line.join(" - ")}\n\n\`\`\`json\n${JSON.stringify(event.payload, null, 2)}\n\`\`\``;
};
