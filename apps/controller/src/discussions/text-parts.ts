/**
 * The parts that the text of a Discussion Input and the text of an Edit
 * Overlap system Post both build from: a quoted file path and a list of
 * sessions. Both texts are written in the controller's own voice and read by
 * agents, so every part that an agent chose, such as a path, is cleaned here
 * and nowhere else.
 */
import { cutKeepingEnd, prepareForQuoting, toIdTail } from "@hercule/contract";

/** The most sessions a text names in one list before it counts the rest. */
const MAX_NAMED_SESSIONS = 5;

/**
 * Returns a file path as inline code, such as `` `src/a.ts` ``, cut to
 * `maxLength` characters keeping its end.
 *
 * An agent chooses the path, and the text around it is the controller's own
 * words. So the path goes through `prepareForQuoting` first: a backtick or
 * quote could end the inline code, and a line break could start a new line
 * that reads like an instruction. Those characters are removed, so a path
 * that contains one is shown without it.
 */
export const quotePath = (path: string, maxLength: number): string =>
  `\`${cutKeepingEnd(prepareForQuoting(path, Number.MAX_SAFE_INTEGER), maxLength)}\``;

/**
 * Returns the sessions as a list such as `session a, session b, and 3 more
 * sessions`: at most `MAX_NAMED_SESSIONS` by name, then the count of the rest.
 * `markSession` returns text to put after a named session's name, such as
 * ` (not told)`, or an empty string for none.
 */
export const buildSessionList = (
  sessionIds: ReadonlyArray<string>,
  markSession: (sessionId: string) => string = () => "",
): string => {
  const named = sessionIds
    .slice(0, MAX_NAMED_SESSIONS)
    .map((id) => `session ${toIdTail(id)}${markSession(id)}`);
  const left = sessionIds.length - named.length;
  if (left === 0) return named.join(", ");
  return `${named.join(", ")}, and ${left} more ${left === 1 ? "session" : "sessions"}`;
};
