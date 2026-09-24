/**
 * The session statuses that count as still in progress: a turn is running, or
 * the session is still being placed. Shared because a sidebar row's marker and
 * a lane's bucket both depend on the same question.
 */
import type { Session, SessionStatus } from "@hercule/contract";

export const WORKING_STATUSES: ReadonlySet<SessionStatus> = new Set(["busy", "starting", "queued"]);

/**
 * Checks whether a thread is over for good: its session has exited and cannot
 * be resumed. Every screen that sorts threads uses this check, because the
 * `exited` status alone means only that the process is gone.
 */
export const isSettled = (session: Session): boolean =>
  session.status === "exited" && !session.resumable;
