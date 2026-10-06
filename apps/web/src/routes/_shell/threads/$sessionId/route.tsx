import type { JSX } from "react";
import { Outlet, createFileRoute, useMatch } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { findAnsweredAssistantId } from "@hercule/client-core";
import { useLiveInvalidation } from "../../../../app/live-invalidation";
import {
  answeredAssistantQuery,
  localRunnerQuery,
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  sessionQuery,
  sessionsQuery,
  subagentsQuery,
  workspacesQuery,
} from "../../../../app/queries";
import { SidePaneSlot } from "../../../../app/side-pane-slot";
import { ThreadDraftsProvider } from "../../../../app/thread-drafts";
import { SidePane } from "../../../../screens/subagents/side-pane";
import { SubagentsSurface } from "../../../../screens/subagents/subagents-surface";

/**
 * The thread: the layout around the page of each of its agents, the
 * session's own agent's page (`index.tsx`) and each subagent's page
 * (`subagents/$subagentId.tsx`). Moving between those pages keeps this
 * layout, its live subscriptions and the side pane it puts in the shell's
 * slot.
 *
 * The loader fetches what every agent's page shows before the route renders,
 * so the first paint is never a spinner over an empty column: the session,
 * its subagents, and the provider instances and the runners, because the
 * composer needs them for its model menu and its locked fields as soon as
 * the thread shows. For an assistant's session it fetches the assistant,
 * whose name the card in the composer's place shows. An assistant deleted
 * since the session ran reads as null rather than failing the load, so its
 * sessions stay readable. Each page's own loader fetches its transcript.
 */
export const Route = createFileRoute("/_shell/threads/$sessionId")({
  loader: async ({ context, params }) => {
    const [session, , runners] = await Promise.all([
      context.queryClient.ensureQueryData(sessionQuery(context.client, params.sessionId)),
      context.queryClient.ensureQueryData(subagentsQuery(context.client, params.sessionId)),
      context.queryClient.ensureQueryData(runnersQuery(context.client)),
      context.queryClient.ensureQueryData(providersQuery(context.client)),
      // The header shows the thread's project and the other threads in its
      // workspace. These lists are prefetched rather than ensured: if the
      // controller cannot list them, the header is plainer, but the screen
      // still opens. They are still fetched here so the breadcrumb and the
      // tabs are there at the first paint instead of popping in later.
      context.queryClient.prefetchQuery(projectsQuery(context.client)),
      context.queryClient.prefetchQuery(resourcesQuery(context.client)),
      context.queryClient.prefetchQuery(workspacesQuery(context.client)),
      context.queryClient.prefetchQuery(sessionsQuery(context.client)),
    ]);
    const assistantId = findAnsweredAssistantId(session);
    await Promise.all([
      context.queryClient.ensureQueryData(
        localRunnerQuery(context.detectLocalRunner, runners.items),
      ),
      assistantId === null
        ? null
        : context.queryClient.ensureQueryData(answeredAssistantQuery(context.client, assistantId)),
    ]);
  },
  component: ThreadLayout,
});

/**
 * Keeps the thread's records current while any of its pages is open, fills
 * the shell's side-pane slot, and renders the open agent's page with the
 * thread's drafts, so what the user typed and has not sent survives a move
 * between the thread's pages.
 *
 * - `session` refetches the session when it changes elsewhere, such as a
 *   queued input being delivered, a turn finishing or a Request opening.
 * - `subagent` refetches the session's subagents when one starts or changes.
 */
function ThreadLayout(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();
  const { sessionId } = Route.useParams();
  const { openRequests } = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  useLiveInvalidation(live, queryClient, "session");
  useLiveInvalidation(live, queryClient, "subagent");

  // The subagent whose page is open, so the side pane can mark its row.
  const subagentId = useMatch({
    from: "/_shell/threads/$sessionId/subagents/$subagentId",
    shouldThrow: false,
  })?.params.subagentId;

  return (
    <>
      <SidePaneSlot>
        <SidePane>
          <SubagentsSurface sessionId={sessionId} subagentId={subagentId} />
        </SidePane>
      </SidePaneSlot>
      {/* Keyed by the session, so one thread's drafts never show on another:
          the router keeps this layout when only the session id changes. */}
      <ThreadDraftsProvider key={sessionId} openRequests={openRequests}>
        <Outlet />
      </ThreadDraftsProvider>
    </>
  );
}
