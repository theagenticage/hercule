/**
 * The one Request a screen shows when a session waits on several at once.
 */
import type { Session, SessionRequest } from "@hercule/contract";

/**
 * Returns the oldest of `session`'s open Requests, the one its agents have
 * waited on longest, or null when nothing waits on the user. It may be the
 * session's own agent's Request or a subagent's.
 *
 * Every screen that shows one Request for a thread shows this one, so the
 * dock, the sidebar and the Office agree. When it is answered, the next
 * oldest takes its place. The desktop notifications are the exception: they
 * follow the newest Request, because a notification announces what just
 * arrived (see `listWaitingThreads`).
 */
export const findOldestOpenRequest = (session: Session): SessionRequest | null =>
  session.openRequests[0] ?? null;
