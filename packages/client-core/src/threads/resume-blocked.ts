/**
 * Why a thread cannot take input, in the words a placeholder can say - or
 * `null` when it can. A session that has exited is refused only when it
 * cannot be resumed, and then for one of two reasons the record already
 * carries: no native session means the transcript is gone; otherwise the
 * runner it ran on was retired.
 */
import type { Session } from "@hydra/contract";

/**
 * An exit nothing can pick up: the thread is over for good. Every surface that
 * sorts threads asks this, rather than reading a status that says only that
 * the process is gone.
 */
export const isSettled = (session: Session): boolean =>
  session.status === "exited" && !session.resumable;

export const resumeBlockedReason = (session: Session): string | null => {
  if (session.status !== "exited" || session.resumable) return null;
  return session.nativeSessionId === null ? "its transcript is gone" : "its runner was retired";
};
