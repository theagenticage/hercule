/**
 * Returns why a thread cannot take input, as a phrase the composer placeholder
 * can show, or `null` when the thread can take input. Only an exited session
 * that cannot be resumed is blocked, for one of two reasons:
 *
 * - it has no native session id, so its transcript is gone;
 * - otherwise, the runner it ran on was retired.
 */
import type { Session } from "@hercule/contract";

export const findResumeBlockedReason = (session: Session): string | null => {
  if (session.status !== "exited" || session.resumable) return null;
  return session.nativeSessionId === null ? "its transcript is gone" : "its runner was retired";
};
