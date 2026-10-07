/**
 * Keeps an assistant's Conversation current through the live connection
 * while it is open: the messages it holds and its current session. Drops
 * the messages when it closes.
 */
import { useEffect } from "react";
import { partialMatchKey, type QueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  queryKeys,
  type HerculeClient,
  type Live,
} from "@hercule/client-core";
import { readMessagePage, removeQueryOnceUnobserved, storeNewestMessages } from "../../app/queries";

/**
 * Subscribes to the `conversation` topic while the calling component is
 * mounted, and keeps the conversation `conversationId` current with it. Call
 * it in the Conversation's screen: the shell does not subscribe to the
 * topic, so a push costs nothing while no Conversation is open.
 *
 * A push that names this conversation, or names none, as the controller's
 * first push on every subscription does:
 *
 * - reads the newest page of messages, and merges it into the pages held
 *   (see `storeNewestMessages`). The pages read earlier are never read
 *   again, so a push costs one page however far the user has scrolled up.
 * - reads the conversation's current session again, because a new message
 *   can come from a session that has just started.
 *
 * When the read of the newest page fails, the pages held stay as they are.
 * The next push reads the newest page again, and the controller sends one
 * each time the topic is subscribed again, after every reconnect.
 *
 * When the calling component unmounts, the pages of messages held are
 * dropped, after the topic is left (see `removeQueryOnceUnobserved`). Only
 * an open Conversation keeps them current, so the cache would otherwise hold them out of date, with every
 * page the user scrolled back through. They are dropped here rather than
 * when the route is left, so a push or a send that lands in between cannot
 * bring them back.
 *
 * `live` is `null` to draw the Conversation without live changes, as the
 * specimen does: nothing is subscribed or dropped then, because the
 * specimen's pages are seeded once and never read.
 */
export const useConversationLive = (
  live: Live | null,
  queryClient: QueryClient,
  client: HerculeClient,
  conversationId: string,
): void => {
  useEffect(() => {
    if (live === null) return;
    const messagesKey = queryKeys.conversationMessages(conversationId);
    let subscribed = true;
    const unsubscribe = live.subscribe("conversation", (keys) => {
      // A pushed key is this conversation's, or a prefix of every
      // conversation's.
      if (!keys.some((key) => partialMatchKey(messagesKey, key))) return;
      invalidateWithoutCancelling(queryClient, queryKeys.conversationSession(conversationId));
      void readMessagePage(client, conversationId, undefined).then(
        (newest) => (subscribed ? storeNewestMessages(queryClient, conversationId, newest) : null),
        () => null,
      );
    });
    return () => {
      subscribed = false;
      unsubscribe();
      removeQueryOnceUnobserved(queryClient, messagesKey);
    };
  }, [live, queryClient, client, conversationId]);
};
