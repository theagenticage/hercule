/**
 * The reads behind an assistant's conversation screen: which conversation it
 * shows, the messages it draws, and which assistant a session answered.
 */
import type { Conversation, ConversationMessage, Session } from "@hercule/contract";

/**
 * Returns the assistant's conversation on the web channel from a
 * `conversation.query` result, or null when the result holds none.
 */
export const findWebConversation = (items: readonly Conversation[]): Conversation | null =>
  items.find((conversation) => conversation.channel === "web") ?? null;

/**
 * Flattens the pages of `conversation.queryMessages` into one list of
 * messages, oldest first. The screen reads its pages newest first, so the
 * latest messages load first and "Show earlier messages" adds a page of older
 * ones.
 */
export const flattenMessagePages = (
  pages: ReadonlyArray<{ readonly items: readonly ConversationMessage[] }>,
): readonly ConversationMessage[] =>
  pages.flatMap((page) => page.items).sort((a, b) => a.position - b.position);

/**
 * Returns the id of the assistant a session answered, or null when the
 * session is not part of a conversation. A session that runs an agent outside
 * a conversation (a workflow step, say) also has an `agentId`, so the
 * `conversationId` is what marks a session as an assistant's.
 */
export const findAnsweredAssistantId = (session: Session): string | null =>
  session.conversationId === null ? null : session.agentId;
