/**
 * The word the sidebar row and the conversation header show beside an
 * assistant's name, read from the newest session of its conversations.
 */
import type { Session } from "@hercule/contract";
import { WORKING_STATUSES } from "../threads/status";

/**
 * What an assistant with a session is doing, as the owner sees it:
 *
 * - "working": a turn runs, or the session is still being placed;
 * - "idle": the session is loaded and waits for a message;
 * - "asleep": the session has exited and the next message resumes it;
 * - "unavailable": the session has exited and cannot be resumed, or it is
 *   held by the crash-loop guard. The next message starts a new session, or
 *   resumes the held one. For a held session, the owner was told with the
 *   notice "<name> can't be reached: its session exited before it could
 *   start a turn; send another message to try again".
 */
export type AssistantPresence = "working" | "idle" | "asleep" | "unavailable";

/**
 * Returns the newest of the assistant's conversation sessions in `sessions`
 * (by `createdAt`), or null when it has none. The newest session is the one
 * the next message goes to, so it is the one presence is read from. Sessions
 * outside a conversation are ignored, even when they carry the assistant's
 * `agentId`.
 */
export const findNewestConversationSession = (
  assistantId: string,
  sessions: readonly Session[],
): Session | null => {
  let newest: Session | null = null;
  for (const session of sessions) {
    if (session.agentId !== assistantId || session.conversationId === null) continue;
    if (newest === null || session.createdAt > newest.createdAt) newest = session;
  }
  return newest;
};

/**
 * Returns the presence of an assistant whose newest conversation session is
 * `session`, or null when it has none yet.
 *
 * An assistant that has never run has no presence to show. "asleep" would
 * claim a session that the next message resumes, and there is none: the next
 * message starts the first one.
 *
 * The sidebar finds that session in the session list with
 * `findNewestConversationSession`. The conversation screen passes its current
 * session, the same record its activity row reads, so the header and the row
 * under the last message never disagree.
 */
export const decideAssistantPresence = (session: Session | null): AssistantPresence | null => {
  if (session === null) return null;
  if (WORKING_STATUSES.has(session.status)) return "working";
  if (session.status === "idle") return "idle";
  return session.resumable && !session.resumeHeld ? "asleep" : "unavailable";
};
