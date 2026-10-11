/**
 * Groups of session statuses, and checks on a session's status, that more
 * than one screen asks about.
 */
import type { Session, SessionStatus } from "@hercule/contract";

/**
 * The statuses of a session that has not exited: every status but `exited`.
 * A read of the live sessions filters on these, as the desktop app's "From
 * runs" does.
 */
export const LIVE_SESSION_STATUSES = [
  "queued",
  "starting",
  "idle",
  "busy",
] as const satisfies ReadonlyArray<SessionStatus>;

/**
 * The session statuses that count as still in progress: a turn is running, or
 * the session is still being placed. Shared because a sidebar row's marker and
 * a lane's bucket both depend on the same question.
 */
export const WORKING_STATUSES: ReadonlySet<SessionStatus> = new Set(["busy", "starting", "queued"]);

/**
 * Checks whether a thread is over for good: its session has exited and cannot
 * be resumed. Every screen that sorts threads uses this check, because the
 * `exited` status alone means only that the process is gone.
 */
export const isSettled = (session: Session): boolean =>
  session.status === "exited" && !session.resumable;
