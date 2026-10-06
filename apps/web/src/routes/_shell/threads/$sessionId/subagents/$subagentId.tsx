import type { JSX } from "react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { resolveDisplayTimezone } from "@hercule/client-core";
import type { Subagent } from "@hercule/contract";
import { EmptyState } from "@hercule/ui";
import { settingsQuery, subagentsQuery, transcriptQuery } from "../../../../../app/queries";
import { AgentPage } from "../../../../../screens/thread/agent-page";

/**
 * One subagent's page, in the main pane in place of the thread's own page:
 * the brief its parent gave it, its transcript, and a status card where the
 * thread has its composer. Like the thread's page, it draws its own header,
 * so the shell's top bar is hidden here.
 *
 * The loader checks that the session has the subagent, so a link to one it
 * does not have shows that instead of an empty page, then fetches the
 * subagent's transcript before the route renders. A subagent missing from
 * the cached list may have started since the list was read, such as one
 * whose Request docked before its record was refetched, so the loader reads
 * the list again before it gives up.
 */
export const Route = createFileRoute("/_shell/threads/$sessionId/subagents/$subagentId")({
  staticData: { title: "Subagent", ownsTopBar: true },
  loader: async ({ context, params }) => {
    const query = subagentsQuery(context.client, params.sessionId);
    const hasSubagent = (subagents: readonly Subagent[]): boolean =>
      subagents.some((subagent) => subagent.id === params.subagentId);
    if (
      !hasSubagent(await context.queryClient.ensureQueryData(query)) &&
      !hasSubagent(await context.queryClient.fetchQuery({ ...query, staleTime: 0 }))
    ) {
      // The router acts on a thrown `notFound`, which is a plain descriptor
      // rather than an Error.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw notFound();
    }
    await context.queryClient.ensureQueryData(
      transcriptQuery(context.client, params.sessionId, params.subagentId),
    );
  },
  component: SubagentPage,
  notFoundComponent: MissingSubagent,
});

function SubagentPage(): JSX.Element {
  const { client, live } = Route.useRouteContext();
  const { sessionId, subagentId } = Route.useParams();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const timezone = resolveDisplayTimezone(settings.user.timezone);

  // The key is the session id and the subagent id, for the reason the
  // thread's page gives: the page holds per-agent state that must not carry
  // over from the previous subagent.
  return (
    <AgentPage
      key={`${sessionId}/${subagentId}`}
      client={client}
      live={live}
      sessionId={sessionId}
      subagentId={subagentId}
      timezone={timezone}
    />
  );
}

/** Says the thread has no subagent with this id, and links back to the thread. */
function MissingSubagent(): JSX.Element {
  const { sessionId } = Route.useParams();
  return (
    <EmptyState headline="This thread has no subagent with this id.">
      <Link
        to="/threads/$sessionId"
        params={{ sessionId }}
        className="self-start text-row text-muted underline underline-offset-2 hover:text-ink"
      >
        Go to the thread
      </Link>
    </EmptyState>
  );
}
