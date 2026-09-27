/**
 * The row the conversation screen shows under its last message, read from the
 * conversation's current session.
 */
import type { Session } from "@hercule/contract";
import { WORKING_STATUSES } from "../threads/status";

export type ConversationActivity =
  | { readonly kind: "working"; readonly sessionId: string }
  | { readonly kind: "awaiting-approval"; readonly sessionId: string }
  | { readonly kind: "quiet" };

/**
 * Returns what the conversation's current session is doing:
 *
 * - "awaiting-approval", with the session's id, when it waits on a permission
 *   request; the row links to that session;
 * - "working", with the session's id, when it is queued, starting or busy;
 *   the row links to that session, where the work can be followed;
 * - "quiet" when there is no session, when it is idle, or when it has exited.
 *
 * An exited session can still carry the request it was waiting on when it
 * ended. Nobody can answer that request any more, so it counts as quiet.
 */
export const decideConversationActivity = (session: Session | null): ConversationActivity => {
  if (session === null || session.status === "exited") return { kind: "quiet" };
  if (session.openRequest !== null) return { kind: "awaiting-approval", sessionId: session.id };
  return WORKING_STATUSES.has(session.status)
    ? { kind: "working", sessionId: session.id }
    : { kind: "quiet" };
};
