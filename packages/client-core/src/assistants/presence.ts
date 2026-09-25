/**
 * The word the sidebar row and the conversation header show beside an
 * assistant's name: whether any of its sessions is still around to answer.
 */
import type { Session } from "@hercule/contract";

export type AssistantPresence = "live" | "idle";

/**
 * Returns "live" while one of the assistant's sessions has not exited (it is
 * queued, starting, idle or busy), and "idle" otherwise. An idle assistant has
 * unloaded its session after a quiet spell and starts a fresh one on the next
 * message.
 */
export const decideAssistantPresence = (
  assistantId: string,
  sessions: readonly Session[],
): AssistantPresence =>
  sessions.some((session) => session.agentId === assistantId && session.status !== "exited")
    ? "live"
    : "idle";
