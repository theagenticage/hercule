import type { JSX } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import type { Subagent } from "@hercule/contract";
import { throwScreenNotFound } from "../../../../../../app/last-screen";
import { subagentsQuery, transcriptQuery } from "../../../../../../app/queries";
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
 */
export const Route = createFileRoute("/_connected/_shell/threads/$sessionId/subagents/$subagentId")(
  {
    staticData: { title: "Subagent" },
    loader: async ({ context: { controller, queryClient }, params, location }) => {
      const query = subagentsQuery(controller.client, params.sessionId);
      const hasSubagent = (subagents: readonly Subagent[]): boolean =>
        subagents.some((subagent) => subagent.id === params.subagentId);
      if (
        !hasSubagent(await queryClient.ensureQueryData(query)) &&
        !hasSubagent(await queryClient.fetchQuery({ ...query, staleTime: 0 }))
      ) {
        throwScreenNotFound(location);
      }
      await queryClient.ensureQueryData(
        transcriptQuery(controller.client, params.sessionId, params.subagentId),
      );
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
