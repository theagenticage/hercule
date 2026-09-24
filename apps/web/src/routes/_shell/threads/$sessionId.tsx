import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { FALLBACK_TIMEZONE, isSupportedTimezone } from "@hercule/client-core";
import {
  localRunnerQuery,
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  sessionQuery,
  sessionsQuery,
  settingsQuery,
  transcriptQuery,
  workspacesQuery,
} from "../../../app/queries";
import { ThreadScreen } from "../../../screens/thread/thread-screen";

/**
 * The thread screen. The screen draws its own header, title included, so the
 * shell's top bar is hidden here.
 *
 * The loader fetches the transcript before the route renders, so the first
 * paint is never a spinner over an empty column. It also fetches the provider
 * instances and the runners, because the composer at the bottom needs them
 * for its model menu and its locked fields as soon as the thread shows.
 */
export const Route = createFileRoute("/_shell/threads/$sessionId")({
  staticData: { title: "Thread", ownsTopBar: true },
  loader: async ({ context, params }) => {
    const [, , runners] = await Promise.all([
      context.queryClient.ensureQueryData(sessionQuery(context.client, params.sessionId)),
      context.queryClient.ensureQueryData(transcriptQuery(context.client, params.sessionId)),
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
    await context.queryClient.ensureQueryData(
      localRunnerQuery(context.detectLocalRunner, runners.items),
    );
  },
  component: ThreadRoute,
});

function ThreadRoute(): JSX.Element {
  const { client, live } = Route.useRouteContext();
  const { sessionId } = Route.useParams();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const stored = settings.user.timezone ?? FALLBACK_TIMEZONE;
  const timezone = isSupportedTimezone(stored) ? stored : FALLBACK_TIMEZONE;

  // The key is the session id. The router does not remount this component
  // when only the param changes, and the screen holds per-thread state (the
  // live tap's buffer, the stream cursor, the composer's state). A new key
  // makes sure none of that carries over from the previous thread.
  return (
    <ThreadScreen
      key={sessionId}
      client={client}
      live={live}
      sessionId={sessionId}
      timezone={timezone}
    />
  );
}
