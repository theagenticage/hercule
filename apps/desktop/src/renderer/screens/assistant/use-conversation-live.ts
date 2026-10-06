/**
 * Keeps an assistant's Conversation current through the live connection
 * while it is open: the messages it holds and its current session.
 */
import { useEffect } from "react";
import { partialMatchKey, type QueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  mergeNewestMessagePage,
  queryKeys,
  type HerculeClient,
  type Live,
  type MessagePage,
  type MessagePages,
} from "@hercule/client-core";
import { readMessagePage } from "../../app/queries";

/**
 * Merges `newest`, a fresh read of the newest messages, into the pages of the
 * conversation `conversationId` held in `queryClient`, by
 * `mergeNewestMessagePage`. Resolves once the merge is in the cache.
 *
 * While an earlier page is being read, the merge is made twice: at once, and
 * again when that read ends. A read of a page writes back the pages it found
 * when it started, with the new page added, so it would undo a merge made in
 * between. Merging the same page twice gives the same pages, so the second
 * merge is harmless when the first one was kept.
 */
export const storeNewestMessages = async (
  queryClient: QueryClient,
  conversationId: string,
  newest: MessagePage,
): Promise<void> => {
  const queryKey = queryKeys.conversationMessages(conversationId);
  const merge = (): void => {
    queryClient.setQueryData<MessagePages>(queryKey, (held) =>
      mergeNewestMessagePage(held, newest),
    );
  };
  merge();
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  const reading = query?.state.fetchStatus === "fetching" ? query.promise : undefined;
  if (reading === undefined) return;
  await reading.catch(() => undefined);
  merge();
};

/**
 * Subscribes to the `conversation` topic while the calling component is
 * mounted, and keeps the conversation `conversationId` current with it. Call
 * it in the Conversation's screen: the shell does not subscribe to the
 * topic, so a push costs nothing while no Conversation is open.
 *
 * A push that names this conversation, or names none, as the push after a
 * reconnect does:
 *
 * - reads the newest page of messages, and merges it into the pages held
 *   (see `storeNewestMessages`). The pages read earlier are never read
 *   again, so a push costs one page however far the user has scrolled up.
 * - reads the conversation's current session again, because a new message
 *   can come from a session that has just started.
 *
 * When the read of the newest page fails, the pages held stay as they are.
 * The next push reads the newest page again, and the live connection sends
 * one after every reconnect.
 *
 * `live` is `null` to draw the Conversation without live changes, as the
 * specimen does: nothing is subscribed then.
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
    };
  }, [live, queryClient, client, conversationId]);
};
