import type { JSX } from "react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import type { Subagent } from "@hercule/contract";
import { subagentsQuery, transcriptQuery } from "../../../../../../app/queries";
import { SubagentPage } from "../../../../../../screens/subagents/subagent-page";
import "../../../../../../screens/thread/not-found.css";

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
 * reads the list again before it gives up.
 */
export const Route = createFileRoute("/_connected/_shell/threads/$sessionId/subagents/$subagentId")(
  {
    staticData: { title: "Subagent" },
    loader: async ({ context: { controller, queryClient }, params }) => {
      const query = subagentsQuery(controller.client, params.sessionId);
      const hasSubagent = (subagents: readonly Subagent[]): boolean =>
        subagents.some((subagent) => subagent.id === params.subagentId);
      if (
        !hasSubagent(await queryClient.ensureQueryData(query)) &&
        !hasSubagent(await queryClient.fetchQuery({ ...query, staleTime: 0 }))
      ) {
        // The router acts on a thrown `notFound`, which is a plain descriptor
        // rather than an Error.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw notFound();
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
 * with the id in the link, laid out as `ThreadNotFound`, with a link back to
 * the thread.
 */
function SubagentNotFound(): JSX.Element {
  const { sessionId } = Route.useParams();
  return (
    <div className="thread-not-found">
      <h1 className="thread-not-found-headline">This thread has no subagent with this id.</h1>
      <Link
        to="/threads/$sessionId"
        params={{ sessionId }}
        className="btn btn--accent thread-not-found-link"
      >
        Go to the thread
      </Link>
    </div>
  );
}
