/**
 * Returns why a thread cannot take input, as a phrase the composer placeholder
 * can show, or `null` when the thread can take input. A thread is blocked when
 * it is archived, or when it has exited and cannot be resumed. The first
 * reason that holds wins:
 *
 * - it is archived (even while the session is still waiting for its stop);
 * - its workspace was removed, or lost;
 * - it has no native session id, so its transcript is gone;
 * - otherwise, the runner it ran on was retired.
 *
 * `workspace` is the session's workspace, or `undefined` when the session has
 * none or the workspace is not loaded. A workspace that is not loaded is never
 * reported as removed, because nothing is known about it.
 */
import type { Session, Workspace } from "@hercule/contract";

export const findResumeBlockedReason = (
  session: Session,
  workspace: Workspace | undefined,
): string | null => {
  if (session.archived !== undefined) return "it is archived";
  if (session.status !== "exited" || session.resumable) return null;
  if (workspace?.status === "deleted" || workspace?.status === "lost") {
    return "its workspace was removed";
  }
  return session.nativeSessionId === null ? "its transcript is gone" : "its runner was retired";
};
