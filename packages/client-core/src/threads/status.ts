/**
 * Groups of session statuses, and checks on a session's status, that more
 * than one screen asks about.
 */
import type { Session, SessionStatus } from "@hercule/contract";

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

/**
 * Checks whether the user marked the thread Done. A Done thread leaves its
 * project's list for the sidebar's Done shelf until it is reopened. Done is
 * the user's word about the thread, apart from its session's status: a done
 * thread may still be running, and a settled one need not be done.
 */
export const isMarkedDone = (session: Session): boolean => session.done !== undefined;
