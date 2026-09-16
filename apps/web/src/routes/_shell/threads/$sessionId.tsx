import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { FALLBACK_TIMEZONE, isSupportedTimezone } from "@hydra/client-core";
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
 * A thread: the screen renders its own chrome, title and all, so the shell's
 * top bar stands down here. The transcript is fetched before the route renders
 * so the first paint is never a spinner over an empty column. The composer at
 * the foot reads the provider instances and the fleet, so its model menu and
 * its locked fields have something to read the moment the thread does.
 */
export const Route = createFileRoute("/_shell/threads/$sessionId")({
  staticData: { title: "Thread", ownsTopBar: true },
  loader: async ({ context, params }) => {
    const [, , runners] = await Promise.all([
      context.queryClient.ensureQueryData(sessionQuery(context.client, params.sessionId)),
      context.queryClient.ensureQueryData(transcriptQuery(context.client, params.sessionId)),
      context.queryClient.ensureQueryData(runnersQuery(context.client)),
      context.queryClient.ensureQueryData(providersQuery(context.client)),
      // What the chrome names beside the title: the project this thread is
      // in, and the other threads in its workspace. Prefetched rather than
      // ensured, for the reason the draft route gives - a controller that
      // cannot list them leaves a thread with a plainer chrome, not a screen
      // the user cannot reach - but prefetched all the same, so the crumb and
      // the tabs are there at the first paint instead of popping in.
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

  // Keyed on the session: the router does not remount this component for a
  // param-only navigation, and this screen holds per-thread state (the live
  // tap's buffer, the seeded stream cursor, the composer's own) that must not
  // carry over from the thread just left to the one just opened.
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
