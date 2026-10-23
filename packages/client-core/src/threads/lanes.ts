/**
 * Groups sessions into the lanes of All sessions, builds its headline, and
 * sums up the step sessions, which sit behind a fold below the lanes. The
 * lanes are returned in their fixed order, because that order is what the
 * screen renders, and an empty lane is returned too.
 *
 * A thread with an open Request, whichever of its agents asked, waits on the
 * user. It sits in the waiting lane only, not also in running or idle, so the
 * user sees it once, where it needs them.
 *
 * A step session is the session an agent step of a workflow run started. It
 * is not a thread: the run drives it, not the user. So it is in no lane and
 * not in the headline, only behind the fold. The same goes for an Agent's
 * session outside a run (kind `agent`): only a Thread is in a lane or counted.
 */
import { toIdTail, type Runner, type Session } from "@hercule/contract";
import { isSameDay } from "../time-context";
import { buildThreadRow, compareNewestFirst, type ThreadRow } from "./rows";
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

/** Checks whether a thread waits on the user: one of its agents has an open Request. */
const waitsOnUser = (session: Session): boolean =>
  session.kind === "thread" && session.openRequests.length > 0;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Returns the lanes of All sessions in their fixed order. A thread with an
 * open Request goes in the waiting lane and in no other. A session that
 * answers an assistant's conversation goes in the assistants lane whatever its
 * status, and in no other lane: the user talks to it on the conversation
 * screen, not in the lanes. A step session and any other Agent session go in
 * no lane.
 */
export const buildLanes = (sessions: readonly Session[]): readonly Lane[] => {
  const assistants = sessions.filter((session) => session.kind === "assistant");
  const waiting = sessions.filter(waitsOnUser);
  const threads = sessions.filter((session) => session.kind === "thread" && !waitsOnUser(session));
  const running = threads.filter((session) => WORKING_STATUSES.has(session.status));
  const idle = threads.filter(takesInput);
  const settled = threads.filter(isSettled);

  return [
    { kind: "waiting", sessions: waiting },
    { kind: "running", sessions: running },
    { kind: "idle", sessions: idle },
    { kind: "assistants", sessions: assistants },
    { kind: "settled", sessions: settled },
  ];
};

/**
 * Returns the headline of All sessions: how many threads wait on the user,
 * how many sessions are running, how many are idle and how many settled in
 * the seven days before `now`, such as "1 waiting on you · 1 running · 2 idle
 * · 3 settled this week". A count of zero is left out. A thread that waits on
 * the user is counted as waiting only, as its lane shows it. Only the sessions
 * in a lane are counted. A step session is summed up by the fold below the
 * lanes instead, and any other Agent session is in neither.
 *
 * Returns "No sessions yet" when there are no sessions at all, and "No
 * threads active this week" when every count is zero. The second wording is
 * true even when step sessions are running at the same time: the fold below
 * then says how many are, such as "show 6 · 2 running", and the two do not
 * contradict each other.
 */
export const buildHeadline = (sessions: readonly Session[], now: Date): string => {
  const waiting = sessions.filter(waitsOnUser).length;
  const counted = sessions.filter(
    (session) =>
      (session.kind === "thread" || session.kind === "assistant") && !waitsOnUser(session),
  );
  const running = counted.filter((session) => WORKING_STATUSES.has(session.status)).length;
  const idle = counted.filter(takesInput).length;
  const settled = counted.filter(
    (session) =>
      isSettled(session) &&
      session.exitedAt !== null &&
      now.getTime() - Date.parse(session.exitedAt) <= SEVEN_DAYS_MS,
  ).length;

  const segments: string[] = [];
  if (waiting > 0) segments.push(`${String(waiting)} waiting on you`);
  if (running > 0) segments.push(`${String(running)} running`);
  if (idle > 0) segments.push(`${String(idle)} idle`);
  if (settled > 0) segments.push(`${String(settled)} settled this week`);

  if (segments.length > 0) return segments.join(" · ");
  // Sessions that exist but fall in none of the counts above (an exit older
  // than a week, one with no `exitedAt`, or a step session) get the second
  // wording.
  return sessions.length === 0 ? "No sessions yet" : "No threads active this week";
};

/** Returns the step sessions among `sessions`, in their order. */
const listStepSessions = (sessions: readonly Session[]): readonly Session[] =>
  sessions.filter((session) => session.kind === "run");

/**
 * Sums up the step sessions, for the fold that hides them on All sessions:
 * how many there are, how many of them are running, how many are queued for
 * a free session slot, and how many were created today, such as
 * "6 · 2 running · 1 queued · 6 today". "Today" is the calendar day of `now`
 * in `timezone`. A count of zero after the first is left out, so it reads
 * "3" or "3 · 1 today". Returns `undefined` when there is no step session.
 */
export const summarizeStepSessions = (
  sessions: readonly Session[],
  now: Date,
  timezone: string,
): string | undefined => {
  const started = listStepSessions(sessions);
  if (started.length === 0) return undefined;
  const queued = started.filter((session) => session.status === "queued").length;
  const running = started.filter((session) => WORKING_STATUSES.has(session.status)).length - queued;
  const today = started.filter((session) =>
    isSameDay(new Date(session.createdAt), now, timezone),
  ).length;
  const segments = [String(started.length)];
  if (running > 0) segments.push(`${String(running)} running`);
  if (queued > 0) segments.push(`${String(queued)} queued`);
  if (today > 0) segments.push(`${String(today)} today`);
  return segments.join(" · ");
};

/**
 * Returns the run that started a step session, as the second line of its row
 * and the crumb of its page show it: "run 1f3a9c2e", the tail of the run's id.
 * Returns `undefined` for a session that is not a step session.
 *
 * The step is left out because the session's title, such as "Fix and ship a
 * pull request · implement", already names the workflow and the step.
 */
export const describeStartingRun = (session: Session): string | undefined =>
  session.runId === null ? undefined : `run ${toIdTail(session.runId)}`;

/**
 * Returns the rows of the step sessions among `sessions`, most recently
 * active first, each with the run that started it on its second line. A
 * session whose runner `runners` lists as disconnected ends in "offline".
 */
export const buildStepSessionRows = (
  sessions: readonly Session[],
  runners: readonly Runner[],
): readonly ThreadRow[] =>
  listStepSessions(sessions)
    .map((session) => buildThreadRow(session, describeStartingRun(session) ?? null, runners))
    .sort(compareNewestFirst);
