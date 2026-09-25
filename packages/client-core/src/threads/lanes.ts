/**
 * Groups sessions into the lanes of the check-in page, and builds its
 * headline. Nothing in this build produces a waiting decision yet, so that
 * lane is always empty. The lanes are still returned in their fixed order,
 * because that order is what the screen renders.
 */
import type { Session } from "@hercule/contract";
import { isSettled, WORKING_STATUSES } from "./status";

export type LaneKind = "waiting" | "running" | "idle" | "assistants" | "settled";

export interface Lane {
  readonly kind: LaneKind;
  readonly sessions: readonly Session[];
}

/**
 * Checks whether a session is waiting for the user: it is neither working nor
 * over for good. An exited session that can be resumed still takes input, so
 * it counts as idle.
 */
const takesInput = (session: Session): boolean =>
  !WORKING_STATUSES.has(session.status) && !isSettled(session);

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Returns the lanes of the check-in page in their fixed order. A session that
 * answers an assistant's conversation goes in the assistants lane whatever its
 * status, and in no other lane: the user talks to it on the conversation
 * screen, not in the lanes.
 */
export const buildLanes = (sessions: readonly Session[]): readonly Lane[] => {
  const assistants = sessions.filter((session) => session.conversationId !== null);
  const threads = sessions.filter((session) => session.conversationId === null);
  const running = threads.filter((session) => WORKING_STATUSES.has(session.status));
  const idle = threads.filter(takesInput);
  const settled = threads.filter(isSettled);

  return [
    { kind: "waiting", sessions: [] },
    { kind: "running", sessions: running },
    { kind: "idle", sessions: idle },
    { kind: "assistants", sessions: assistants },
    { kind: "settled", sessions: settled },
  ];
};

export const buildHeadline = (sessions: readonly Session[], now: Date): string => {
  const running = sessions.filter((session) => WORKING_STATUSES.has(session.status)).length;
  const idle = sessions.filter(takesInput).length;
  const settled = sessions.filter(
    (session) =>
      isSettled(session) &&
      session.exitedAt !== null &&
      now.getTime() - Date.parse(session.exitedAt) <= SEVEN_DAYS_MS,
  ).length;

  const segments: string[] = [];
  if (running > 0) segments.push(`${String(running)} running`);
  if (idle > 0) segments.push(`${String(idle)} idle`);
  if (settled > 0) segments.push(`${String(settled)} settled this week`);

  if (segments.length > 0) return segments.join(" · ");
  // With no sessions at all, say "No sessions yet". Sessions that exist but
  // fall in none of the counts above (an exit older than a week, or one with
  // no `exitedAt`) get "Nothing active this week" instead.
  return sessions.length === 0 ? "No sessions yet" : "Nothing active this week";
};
