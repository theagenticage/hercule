import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { buildSessionAgentState, buildTurns, resolveDisplayTimezone } from "@hercule/client-core";
import {
  assistantsQuery,
  senderSessionQuery,
  sessionQuery,
  settingsQuery,
  transcriptQuery,
} from "../../../../app/queries";
import { AgentPage } from "../../../../screens/thread/agent-page";

/**
 * The thread's own page: the transcript of the session's own agent, with the
 * composer at the bottom. The page draws its own header, title included, so
 * the shell's top bar is hidden here.
 *
 * The loader fetches the transcript before the route renders, so the first
 * paint is never a spinner over an empty column. It then fetches each agent
 * that sent a message into the transcript, once per sender, and the
 * assistants, so a message names its sender at the first paint. Those reads
 * are prefetched rather than ensured: a sender that cannot be read shows as
 * "Another agent" and never fails the load. The thread's layout route
 * fetches everything else the page reads.
 */
export const Route = createFileRoute("/_shell/threads/$sessionId/")({
  staticData: { title: "Thread", ownsTopBar: true },
  loader: async ({ context, params }) => {
    const { client, queryClient } = context;
    const [rows, session] = await Promise.all([
      queryClient.ensureQueryData(transcriptQuery(client, params.sessionId)),
      queryClient.ensureQueryData(sessionQuery(client, params.sessionId)),
    ]);
    const senderSessionIds = new Set(
      buildTurns(rows, buildSessionAgentState(session)).flatMap((turn) =>
        turn.userMessages.flatMap((message) => message.senderSessionId ?? []),
      ),
    );
    if (senderSessionIds.size === 0) return;
    await Promise.all([
      queryClient.prefetchQuery(assistantsQuery(client)),
      ...Array.from(senderSessionIds, (id) =>
        queryClient.prefetchQuery(senderSessionQuery(client, id)),
      ),
    ]);
  },
  component: ThreadPage,
});

function ThreadPage(): JSX.Element {
  const { client, live } = Route.useRouteContext();
  const { sessionId } = Route.useParams();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const timezone = resolveDisplayTimezone(settings.user.timezone);

  // The key is the session id. The router does not remount this component
  // when only the param changes, and the page holds per-agent state (the
  // live tap's buffer, the stream cursor, the composer's state). A new key
  // makes sure none of that carries over from the previous thread.
  return (
    <AgentPage
      key={sessionId}
      client={client}
      live={live}
      sessionId={sessionId}
      subagentId={undefined}
      timezone={timezone}
    />
  );
}
