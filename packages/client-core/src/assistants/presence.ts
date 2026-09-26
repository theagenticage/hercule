/**
 * The word the sidebar row and the conversation header show beside an
 * assistant's name, read from the newest session of its conversations.
 */
import type { Session } from "@hercule/contract";
import { WORKING_STATUSES } from "../threads/status";

/**
 * What an assistant is doing, as the owner sees it:
 *
 * - "working": a turn runs, or the session is still being placed;
 * - "idle": the session is loaded and waits for a message;
 * - "asleep": the session has exited and the next message resumes it, or the
 *   assistant has no session yet and the next message starts one;
 * - "unavailable": the session has exited and cannot be resumed, or it is
 *   held by the crash-loop guard. The next message starts a new session, or
 *   resumes the held one. For a held session, the owner was told with the
 *   notice "<name> can't be reached: its session exited before it could
 *   start a turn; send another message to try again".
 */
export type AssistantPresence = "working" | "idle" | "asleep" | "unavailable";

/**
 * Returns the presence of the assistant with `assistantId`, decided by the
 * newest of its conversation sessions in `sessions` (by `createdAt`). Only
 * the newest session counts, because that is the one the next message goes
 * to. Sessions outside a conversation are ignored, even when they carry the
 * assistant's `agentId`.
 */
export const decideAssistantPresence = (
  assistantId: string,
  sessions: readonly Session[],
): AssistantPresence => {
  let newest: Session | undefined;
  for (const session of sessions) {
    if (session.agentId !== assistantId || session.conversationId === null) continue;
    if (newest === undefined || session.createdAt > newest.createdAt) newest = session;
  }
  if (newest === undefined) return "asleep";
  if (WORKING_STATUSES.has(newest.status)) return "working";
  if (newest.status === "idle") return "idle";
  return newest.resumable && !newest.resumeHeld ? "asleep" : "unavailable";
};
