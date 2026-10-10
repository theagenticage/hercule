import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  collectSenderSessionIds,
  resolveDisplayTimezone,
  waitForSenderReads,
} from "@hercule/client-core";
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
 *   opens, as it did before the list was read here. Their read shares the
 *   senders' wait below, so a list that never answers cannot hold the
 *   thread either.
 * - Once the transcript and the queued inputs are in, it reads each agent
 *   that sent one of those messages, once per sender, and the assistants, so
 *   a message and a queued row name their sender at the first paint. It
 *   waits for those reads for at most `SENDER_READ_WAIT_MS`: a sender's name
 *   only decorates a message, so a controller that never answers one must
 *   not keep the thread from opening. A sender still being read after that
 *   is named when its read answers; until then its rows hold the sender's
 *   place (see `useSenderReading`). Those reads are prefetched, so a sender
 *   that cannot be read shows as "another agent" and never fails the load,
 *   and a sender whose read already failed is not read again.
 */
export const Route = createFileRoute("/_shell/threads/$sessionId/")({
  staticData: { title: "Thread", ownsTopBar: true },
  loader: async ({ context, params }) => {
    const { client, queryClient } = context;
    const queued = inputsQuery(client, params.sessionId);
    const queue = queryClient.prefetchQuery(queued);
    const rows = await queryClient.ensureQueryData(transcriptQuery(client, params.sessionId));
    // One wait covers the queued inputs and the senders they name, so a
    // controller that never answers the queue does not hold the thread either.
    await waitForSenderReads([
      queue.then(() => {
        const inputs = (queryClient.getQueryData(queued.queryKey)?.items ?? []).filter(
          (input) => input.status === "queued",
        );
        const senderSessionIds = collectSenderSessionIds(rows, inputs);
        if (senderSessionIds.length === 0) return;
        return Promise.all([
          queryClient.prefetchQuery(assistantsQuery(client)),
          ...senderSessionIds
            .map((id) => senderSessionQuery(client, id))
            .filter((sender) => queryClient.getQueryState(sender.queryKey)?.status !== "error")
            .map((sender) => queryClient.prefetchQuery(sender)),
        ]);
      }),
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
