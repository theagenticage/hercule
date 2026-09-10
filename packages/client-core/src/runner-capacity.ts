/**
 * The runner page's capacity line: how many of a machine's slots are held and
 * how many sessions wait for one. A session holds its slot from `starting`
 * through `busy` - the controller does not free it until the session exits -
 * so only `queued` is left waiting and only `exited` counts as neither.
 */
import type { Runner, Session, SessionStatus } from "@hydra/contract";

/**
 * The one declaration of which statuses hold a slot - `runnerSessionsQuery`
 * builds its filter from this too, so the fetch and the count can never name
 * a different set of statuses.
 */
export const RUNNING_STATUSES: ReadonlyArray<SessionStatus> = ["starting", "idle", "busy"];

const holdsSlot = new Set<SessionStatus>(RUNNING_STATUSES);

export const capacityLine = (runner: Runner, sessions: ReadonlyArray<Session>): string => {
  const running = sessions.filter((session) => holdsSlot.has(session.status)).length;
  const queued = sessions.filter((session) => session.status === "queued").length;
  const line = `${String(running)} running of ${String(runner.maxConcurrentSessions)}`;
  return queued === 0 ? line : `${line} · ${String(queued)} queued`;
};

/** The queue itself, oldest first: the session that has waited longest starts next. */
export const queuedSessions = (sessions: ReadonlyArray<Session>): ReadonlyArray<Session> =>
  sessions
    .filter((session) => session.status === "queued")
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
