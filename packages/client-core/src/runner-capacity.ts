/**
 * The runner page's capacity line: how many of a runner's session slots are
 * in use, and how many sessions are waiting for one. A session holds its slot
 * from `starting` through `busy`, because the controller frees the slot only
 * when the session exits. So only `queued` sessions are waiting, and only
 * `exited` sessions are neither running nor waiting.
 */
import type { Runner, Session, SessionStatus } from "@hercule/contract";

/**
 * The statuses that hold a slot. `runnerSessionsQuery` builds its filter from
 * this list too, so the query and the count always use the same statuses.
 */
export const RUNNING_STATUSES: ReadonlyArray<SessionStatus> = ["starting", "idle", "busy"];

const holdsSlot = new Set<SessionStatus>(RUNNING_STATUSES);

/** Returns the capacity line, for example `2 running of 4 · 1 queued`. */
export const describeCapacity = (runner: Runner, sessions: ReadonlyArray<Session>): string => {
  const running = sessions.filter((session) => holdsSlot.has(session.status)).length;
  const queued = sessions.filter((session) => session.status === "queued").length;
  const line = `${String(running)} running of ${String(runner.maxConcurrentSessions)}`;
  return queued === 0 ? line : `${line} · ${String(queued)} queued`;
};

/** Returns the queued sessions, oldest first: the session that has waited longest starts next. */
export const listQueuedSessions = (sessions: ReadonlyArray<Session>): ReadonlyArray<Session> =>
  sessions
    .filter((session) => session.status === "queued")
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
