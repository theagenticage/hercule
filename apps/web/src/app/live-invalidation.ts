/**
 * Keeps a screen's data current through the live connection.
 *
 * Records change while a screen is open - an agent triages a task, a machine
 * goes quiet - so a screen should show the controller's current state, not the
 * state when the screen opened. Each push lists the query keys that changed,
 * and the cache fetches them again. The screen itself never deals with the
 * socket.
 *
 * A push never cancels a read that is already running:
 * `invalidateWithoutCancelling` explains why.
 */
import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  buildConversationSessionKeys,
  invalidateWithoutCancelling,
  queryKeys,
  type Live,
} from "@hercule/client-core";
import type { MutableLiveTopic, Session } from "@hercule/contract";

/**
 * Returns each conversation's current session the cache holds. They are the
 * only sessions this app tells apart for `buildConversationSessionKeys`: a
 * push that names any other session reads every current session again.
 */
const listCurrentSessions = (queryClient: QueryClient): Session[] =>
  queryClient
    .getQueriesData<Session | null>({ queryKey: queryKeys.conversationSession() })
    .flatMap(([, session]) => (session === undefined || session === null ? [] : [session]));

/**
 * Subscribes to one topic while the calling component is mounted, and
 * invalidates the query keys each push lists. A `session` push also
 * invalidates the conversations' current sessions it makes stale, as
 * `buildConversationSessionKeys` decides.
 */
export const useLiveInvalidation = (
  live: Live,
  queryClient: QueryClient,
  topic: MutableLiveTopic,
): void => {
  useEffect(
    () =>
      live.subscribe(topic, (keys, ids) => {
        const stale =
          topic === "session"
            ? [...keys, ...buildConversationSessionKeys(ids, listCurrentSessions(queryClient))]
            : keys;
        for (const queryKey of stale) invalidateWithoutCancelling(queryClient, queryKey);
      }),
    [live, queryClient, topic],
  );
};
