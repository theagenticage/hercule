/**
 * Whether an assistant's conversation can be started fresh, as Settings >
 * Assistants offers it: "Start fresh" calls `conversation.rotate`, which
 * refuses a conversation with nothing to start from.
 */
import type { Session } from "@hercule/contract";

/** Whether Start fresh is offered, and when it is not, why in words for the user. */
export type StartFreshAvailability =
  | { readonly available: true; readonly reason?: never }
  | { readonly available: false; readonly reason: string };

/**
 * Decides whether Start fresh is available for a conversation, from its
 * current session (the newest session that answers it, or null when none has
 * started yet).
 *
 * - No session: a conversation's session starts on its first wake, so there
 *   is nothing to distill into memory yet.
 * - A session that never started its process has had no turn either.
 * - Otherwise it is available.
 *
 * `Session` carries no count of turns, so this approximates the controller's
 * own check: a session that started its process but ended before any turn
 * counts as available, and `conversation.rotate` then fails with
 * `invalid_state`. The screen shows that error's message.
 */
export const decideStartFresh = (session: Session | null): StartFreshAvailability => {
  if (session === null) {
    return { available: false, reason: "No session yet. Send a message to start one." };
  }
  if (session.startedAt === null) {
    return { available: false, reason: "No turn yet. The session has not started working." };
  }
  return { available: true };
};
