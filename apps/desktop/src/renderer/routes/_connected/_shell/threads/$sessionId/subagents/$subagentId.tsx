import type { JSX } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import type { Subagent } from "@hercule/contract";
import { throwScreenNotFound } from "../../../../../../app/last-screen";
import {
  markTranscriptCaughtUp,
  subagentsQuery,
  transcriptQuery,
} from "../../../../../../app/queries";
import { SubagentPage } from "../../../../../../screens/subagents/subagent-page";
import { NotFound } from "../../../../../../screens/not-found";

/**
 * One subagent's page, in the main pane in place of the thread's own page:
 * the subagent's transcript, with no composer, because a subagent takes no
 * messages.
 *
 * The loader checks that the session has the subagent, so a link to one it
 * does not have shows that instead of an empty page, then reads the
 * subagent's transcript before the page renders. A subagent missing from
 * the cached list may have started since the list was read, such as one
 * whose Request docked before its record was read again, so the loader
 * reads the list again before it gives up. When the app opened the page at
 * launch, a subagent the session does not have goes to the new-thread
 * screen instead (see `throwScreenNotFound`).
 *
 * A thread that opens from its saved copy has the subagent list, and the
 * transcript of each subagent opened before, in the cache once the thread's
 * own loader has run. When the thread is not cached yet, this loader waits
 * for that loader first, so it finds them and makes no read the copy
 * answers. A transcript cached from the copy is not read again by the
 * loader: the page brings it up to date (see `transcriptCatchUpQuery`).
 * One read from the controller needs no catch-up and is marked as caught up.
 */
export const Route = createFileRoute("/_connected/_shell/threads/$sessionId/subagents/$subagentId")(
  {
    staticData: { title: "Subagent" },
    loader: async ({
      context: { controller, queryClient },
      params,
      location,
      parentMatchPromise,
    }) => {
      const { client } = controller;
      const { sessionId, subagentId } = params;
      if (queryClient.getQueryData(transcriptQuery(client, sessionId).queryKey) === undefined) {
        await parentMatchPromise;
      }
      const query = subagentsQuery(client, sessionId);
      const hasSubagent = (subagents: readonly Subagent[]): boolean =>
        subagents.some((subagent) => subagent.id === subagentId);
      if (
        !hasSubagent(await queryClient.ensureQueryData(query)) &&
        !hasSubagent(await queryClient.fetchQuery({ ...query, staleTime: 0 }))
      ) {
        throwScreenNotFound(location);
      }
      const transcript = transcriptQuery(client, sessionId, subagentId);
      const isCached = queryClient.getQueryData(transcript.queryKey) !== undefined;
      await queryClient.ensureQueryData(transcript);
      if (!isCached) markTranscriptCaughtUp(queryClient, sessionId, subagentId);
    },
    component: SubagentPageRoute,
    notFoundComponent: SubagentNotFound,
  },
);

function SubagentPageRoute(): JSX.Element {
  const { sessionId, subagentId } = Route.useParams();
  // Keyed by the session id and the subagent id, for the reason the
  // thread's page gives: the page holds one agent's live tail and scroll
  // position, which must not carry over to another agent.
  return (
    <SubagentPage
      key={`${sessionId}/${subagentId}`}
      sessionId={sessionId}
      subagentId={subagentId}
    />
  );
}

/**
 * Renders what the subagent's route shows when the thread has no subagent
 * with the id in the link, with a link back to the thread.
 */
function SubagentNotFound(): JSX.Element {
  const { sessionId } = Route.useParams();
  return (
    <NotFound headline="This thread has no subagent with this id.">
      <Link to="/threads/$sessionId" params={{ sessionId }} className="btn btn--accent">
        Go to the thread
      </Link>
    </NotFound>
  );
}
