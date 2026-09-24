/**
 * Why a thread cannot take input, in the words a placeholder can say - or
 * `null` when it can. A session that has exited is refused only when it
 * cannot be resumed, and then for one of two reasons the record already
 * carries: no native session means the transcript is gone; otherwise the
 * runner it ran on was retired.
 */
import type { Session } from "@hercule/contract";

export const findResumeBlockedReason = (session: Session): string | null => {
  if (session.status !== "exited" || session.resumable) return null;
  return session.nativeSessionId === null ? "its transcript is gone" : "its runner was retired";
};
