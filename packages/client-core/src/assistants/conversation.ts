/**
 * The reads behind an assistant's conversation screen: which conversation it
 * shows, the messages it draws and the time separators above them, which
 * assistant a session answered, and whether a session's queued inputs may be
 * steered or cancelled.
 */
import type { Conversation, ConversationMessage, Session } from "@hercule/contract";
import { chooseStamps } from "../time-context";

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
 * Returns the time separator to show above each message, by position, or
 * undefined for none. Only the owner's messages carry one: an owner's message
 * opens an exchange, as the user's message opens a turn in a thread, and the
 * replies and notices that answer it follow under the same time. Messages
 * sent in the same minute share one separator.
 */
export const chooseMessageStamps = (
  messages: readonly ConversationMessage[],
  timezone: string,
): readonly (string | undefined)[] =>
  chooseStamps(
    messages.map((message) => (message.senderRole === "owner" ? message.createdAt : null)),
    timezone,
  );

/**
 * Returns the id of the assistant a session answered, or null when the
 * session is not part of a conversation. A session that runs an agent outside
 * a conversation (a workflow step, say) also has an `agentId`, so the
 * `conversationId` is what marks a session as an assistant's.
 */
export const findAnsweredAssistantId = (session: Session): string | null =>
  session.conversationId === null ? null : session.agentId;

/**
 * Checks whether the session view offers Steer and Cancel on the session's
 * queued inputs. Returns false for a session that answers an assistant's
 * conversation: its queued inputs are the owner's messages, which the
 * conversation already shows as sent. They go in on their own: steered into
 * a running turn, sent as the next turn, or kept for the resume. The owner
 * corrects one by sending another message in the conversation instead.
 */
export const canSteerOrCancelQueuedInputs = (session: Session): boolean =>
  session.conversationId === null;
