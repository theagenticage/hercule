/**
 * The statuses a session reads as still in progress: a running turn, or
 * placement still working out where it lands. Shared because a row's mark and
 * a lane's bucket are the same question asked from two screens.
 */
import type { Session, SessionStatus } from "@hercule/contract";

export const WORKING_STATUSES: ReadonlySet<SessionStatus> = new Set(["busy", "starting", "queued"]);

/**
 * An exit nothing can pick up: the thread is over for good. Every surface that
 * sorts threads asks this, rather than reading a status that says only that
 * the process is gone.
 */
export const isSettled = (session: Session): boolean =>
  session.status === "exited" && !session.resumable;
