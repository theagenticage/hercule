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
 * - its last process exited before it started any turn, and no input has
 *   been stored for it since (`awaitingNewInput`);
 * - input is waiting for it.
 *
 * Such a session died before doing any work, so resuming it for the same
 * input would most likely fail the same way, over and over. The input waits
 * instead. New input lifts the hold: someone is asking again, and the
 * session is resumed for all of its waiting input.
 */
export const isResumeHeld = (
  session: Pick<StoredSession, "status" | "awaitingNewInput" | "inputWaiting">,
): boolean => session.status === "exited" && session.awaitingNewInput && session.inputWaiting;
