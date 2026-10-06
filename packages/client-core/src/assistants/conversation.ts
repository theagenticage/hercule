/**
 * The reads behind an assistant's conversation screen: which conversation it
 * shows, the messages it draws and the time separators above them, how a
 * fresh read of the newest messages joins the pages already held, which
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

/** One page of `conversation.queryMessages`, newest first. `nextCursor` reads the page before it. */
export interface MessagePage {
  readonly items: readonly ConversationMessage[];
  readonly nextCursor?: string;
}

/**
 * The pages of a conversation's messages a screen holds, newest page first,
 * with the cursor each page was read with: `undefined` for the newest page.
 * It has the shape of TanStack Query's `InfiniteData`, so a screen can store
 * the result of `mergeNewestMessagePage` in its query cache as it is.
 */
export interface MessagePages {
  pages: MessagePage[];
  pageParams: (string | undefined)[];
}

/**
 * Joins a fresh read of the newest page of messages (`newest`) into the pages
 * a screen holds (`held`), and returns the new pages. The screen calls it when
 * a message may have been stored, so it reads one page rather than every page
 * it holds again.
 *
 * Messages are matched by `position`, never by text: a held message with the
 * same position as a fresh one is the same message, and the fresh copy
 * replaces it. The result is:
 *
 * - `newest` alone, read with no cursor, when nothing is held, when the held
 *   pages hold no message, or when `newest` neither holds the newest held
 *   message nor the one right after it. In the last case more messages were
 *   stored than one page holds, so a gap would sit between `newest` and the
 *   held pages.
 * - Otherwise the held pages, with each message `newest` holds replaced by
 *   its fresh copy and the messages newer than the held ones added to the
 *   newest page. The held cursors are kept, so the screen reads earlier
 *   messages from where it left off. A held page whose messages all moved to
 *   the newest page stays, empty, so every cursor still reads the page after
 *   the one before it.
 */
export const mergeNewestMessagePage = (
  held: MessagePages | undefined,
  newest: MessagePage,
): MessagePages => {
  const heldNewest = held?.pages[0]?.items[0];
  const freshOldest = newest.items.at(-1);
  if (held === undefined || heldNewest === undefined || freshOldest === undefined) {
    return { pages: [newest], pageParams: [undefined] };
  }
  // Positions count up by one, so a fresh page whose oldest message comes
  // right after the newest held one leaves no gap.
  if (freshOldest.position > heldNewest.position + 1) {
    return { pages: [newest], pageParams: [undefined] };
  }

  const freshPositions = new Set(newest.items.map((message) => message.position));
  const pages = held.pages.map((page, index): MessagePage => {
    const kept = page.items.filter((message) => !freshPositions.has(message.position));
    return {
      items:
        index === 0 ? [...newest.items, ...kept].sort((a, b) => b.position - a.position) : kept,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  });
  return { pages, pageParams: [...held.pageParams] };
};

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
