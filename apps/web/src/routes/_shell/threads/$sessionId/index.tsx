import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { collectSenderSessionIds, resolveDisplayTimezone } from "@hercule/client-core";
import {
  assistantsQuery,
  inputsQuery,
  senderSessionQuery,
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
 * paint is never a spinner over an empty column. It also reads the two
 * things below; the thread's layout route fetches the rest of what the page
 * reads.
 *
 * - The queued inputs are prefetched rather than ensured: if the controller
 *   cannot list them, the queued list stays empty, but the thread still
 *   opens, as it did before the list was read here.
 * - Once the transcript and the queued inputs are in, it reads each agent
 *   that sent one of those messages, once per sender, and the assistants, so
 *   a message and a queued row name their sender at the first paint. Those
 *   reads are prefetched too: a sender that cannot be read shows as "another
 *   agent" and never fails the load.
 */
export const Route = createFileRoute("/_shell/threads/$sessionId/")({
  staticData: { title: "Thread", ownsTopBar: true },
  loader: async ({ context, params }) => {
    const { client, queryClient } = context;
    const queued = inputsQuery(client, params.sessionId);
    const [rows] = await Promise.all([
      queryClient.ensureQueryData(transcriptQuery(client, params.sessionId)),
      queryClient.prefetchQuery(queued),
    ]);
    const inputs = (queryClient.getQueryData(queued.queryKey)?.items ?? []).filter(
      (input) => input.status === "queued",
    );
    const senderSessionIds = collectSenderSessionIds(rows, inputs);
    if (senderSessionIds.length === 0) return;
    await Promise.all([
      queryClient.prefetchQuery(assistantsQuery(client)),
      ...senderSessionIds.map((id) => queryClient.prefetchQuery(senderSessionQuery(client, id))),
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
