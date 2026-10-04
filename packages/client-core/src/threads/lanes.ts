/**
 * Groups sessions into the lanes of All sessions, builds its headline, and
 * sums up the sessions that workflows started, which sit behind a fold below
 * the lanes. Nothing in this build produces a waiting decision yet, so that
 * lane is always empty. The lanes are still returned in their fixed order,
 * because that order is what the screen renders.
 *
 * A session a workflow run started is not a thread: the run drives it, not
 * the user. So it is in no lane and not in the headline, only behind the fold.
 */
import type { Session } from "@hercule/contract";
import { toIdTail } from "../id-tail";
import { isSameDay } from "../time-context";
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

/** Checks whether a workflow run started a session, as one of its agent steps. */
const isStartedByRun = (session: Session): boolean => session.runId !== null;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Returns the lanes of All sessions in their fixed order. A session that
 * answers an assistant's conversation goes in the assistants lane whatever its
 * status, and in no other lane: the user talks to it on the conversation
 * screen, not in the lanes. A session a workflow run started goes in no lane.
 */
export const buildLanes = (sessions: readonly Session[]): readonly Lane[] => {
  const shown = sessions.filter((session) => !isStartedByRun(session));
  const assistants = shown.filter((session) => session.conversationId !== null);
  const threads = shown.filter((session) => session.conversationId === null);
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

/**
 * Returns the headline of All sessions: how many sessions are running, how
 * many are idle and how many settled in the seven days before `now`, such as
 * "1 running · 2 idle · 3 settled this week". A count of zero is left out.
 * The sessions a workflow run started are not counted.
 *
 * Returns "No sessions yet" when there are no sessions at all, and "Nothing
 * active this week" when every count is zero.
 */
export const buildHeadline = (sessions: readonly Session[], now: Date): string => {
  const counted = sessions.filter((session) => !isStartedByRun(session));
  const running = counted.filter((session) => WORKING_STATUSES.has(session.status)).length;
  const idle = counted.filter(takesInput).length;
  const settled = counted.filter(
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
  // fall in none of the counts above (an exit older than a week, one with no
  // `exitedAt`, or one a workflow run started) get "Nothing active this
  // week" instead.
  return sessions.length === 0 ? "No sessions yet" : "Nothing active this week";
};

/** Returns the sessions that workflow runs started, in the order of `sessions`. */
export const listWorkflowSessions = (sessions: readonly Session[]): readonly Session[] =>
  sessions.filter(isStartedByRun);

/**
 * Sums up the sessions that workflow runs started, for the fold that hides
 * them on All sessions: how many there are, how many of them are running, and
 * how many were created today, such as "2 · 1 running · 14 today". "Today" is
 * the calendar day of `now` in `timezone`. A running or today count of zero
 * is left out, so it reads "3" or "3 · 1 today". Returns `undefined` when no
 * workflow run has started a session.
 */
export const summarizeWorkflowSessions = (
  sessions: readonly Session[],
  now: Date,
  timezone: string,
): string | undefined => {
  const started = listWorkflowSessions(sessions);
  if (started.length === 0) return undefined;
  const running = started.filter((session) => WORKING_STATUSES.has(session.status)).length;
  const today = started.filter((session) =>
    isSameDay(new Date(session.createdAt), now, timezone),
  ).length;
  const segments = [String(started.length)];
  if (running > 0) segments.push(`${String(running)} running`);
  if (today > 0) segments.push(`${String(today)} today`);
  return segments.join(" · ");
};

/**
 * Returns which run and step started a session, as the second line of its
 * row says it: "step implement · run 1f3a9c2e", or "run 1f3a9c2e" for a
 * session with no step. Returns `undefined` for a session no run started.
 */
export const describeStartingStep = (session: Session): string | undefined => {
  if (session.runId === null) return undefined;
  const run = `run ${toIdTail(session.runId)}`;
  return session.stepId === null ? run : `step ${session.stepId} · ${run}`;
};
