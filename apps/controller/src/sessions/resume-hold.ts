/**
 * The crash-loop guard: the rule that keeps an exited session from being
 * resumed again and again for input it never gets to.
 */
import type { StoredSession } from "./repository";

/**
 * Checks whether an exited session is held back from an automatic resume.
 * Returns `true` when all of these hold:
 *
 * - the session has exited;
 * - the guard is armed (`crashGuardArmed`): the session's last resume started
 *   no turn, and no input has been stored for it since;
 * - input is waiting for it;
 * - it could otherwise be resumed (`resumable`).
 *
 * Such a session died before doing any work, so resuming it for the same
 * input would most likely fail the same way, over and over. The input waits
 * instead. New input disarms the guard: someone is asking again, and the
 * session is resumed for all of its waiting input. A session that cannot be
 * resumed at all is not held: its waiting input is dropped for that reason
 * instead.
 */
export const isResumeHeld = (
  session: Pick<StoredSession, "status" | "crashGuardArmed" | "inputWaiting" | "resumable">,
): boolean =>
  session.status === "exited" &&
  session.crashGuardArmed &&
  session.inputWaiting &&
  session.resumable;
