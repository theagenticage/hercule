/**
 * Reads the assistants as the sidebar shows them, for the Assistants section
 * and for Waiting on you, the dock badge and the notifications.
 */
import { queryOptions, useQueries, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildAssistantRows, type AssistantRow } from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import { assistantsQuery, currentConversationSessionQuery, runnersQuery } from "./queries";

/**
 * Returns one row per assistant, sorted by name, each with its pose and the
 * current session of its main conversation, as `buildAssistantRows` builds
 * them.
 *
 * The shell's loader reads the assistants, the runners and every current
 * session, so the rows are complete from the first frame. Only the
 * assistants and the runners suspend. A current session that is still being
 * read for the first time, such as that of an assistant a live push just
 * added, counts as no session, so the assistant shows idle until the read
 * returns, and the whole shell does not wait for one row.
 *
 * A current session read fails the way a suspending read does: a failed
 * first read throws to the route's error screen, rather than showing the
 * assistant idle, and a failed read again keeps the session read before.
 */
export function useAssistantRows(): AssistantRow[] {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const assistants = useSuspenseQuery(assistantsQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const sessions = useQueries({
    queries: assistants.map(({ mainConversationId }) =>
      queryOptions({
        ...currentConversationSessionQuery(client, mainConversationId),
        throwOnError: (_error, query) => query.state.data === undefined,
      }),
    ),
  });
  const currentSessions = new Map<string, Session>();
  assistants.forEach(({ id }, index) => {
    const session = sessions[index]?.data;
    if (session !== undefined && session !== null) currentSessions.set(id, session);
  });
  return buildAssistantRows(assistants, currentSessions, runners);
}
