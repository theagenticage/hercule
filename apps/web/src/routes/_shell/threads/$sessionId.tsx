import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { FALLBACK_TIMEZONE, isSupportedTimezone } from "@hydra/client-core";
import {
  localRunnerQuery,
  profilesQuery,
  providersQuery,
  runnersQuery,
  sessionQuery,
  settingsQuery,
  transcriptQuery,
} from "../../../app/queries";
import { ThreadScreen } from "../../../screens/thread/thread-screen";

/**
 * A thread: `session.title` frames the top bar in place of this route's own
 * (there is no static one to give it - a thread's title is a record, not a
 * screen name), and the transcript is fetched before the route renders so the
 * first paint is never a spinner over an empty column. The composer at the
 * foot needs the same catalogs the new-thread composer does - the provider
 * instances, the fleet and the profiles - so its model menu and its read-only
 * fields have something to read the moment the thread does.
 */
export const Route = createFileRoute("/_shell/threads/$sessionId")({
  loader: async ({ context, params }) => {
    const [session, , runners] = await Promise.all([
      context.queryClient.ensureQueryData(sessionQuery(context.client, params.sessionId)),
      context.queryClient.ensureQueryData(transcriptQuery(context.client, params.sessionId)),
      context.queryClient.ensureQueryData(runnersQuery(context.client)),
      context.queryClient.ensureQueryData(providersQuery(context.client)),
      context.queryClient.ensureQueryData(profilesQuery(context.client)),
    ]);
    await context.queryClient.ensureQueryData(
      localRunnerQuery(context.detectLocalRunner, runners.items),
    );
    return { title: session.title, crumb: `thread · ${params.sessionId.slice(0, 8)}` };
  },
  component: ThreadRoute,
});

function ThreadRoute(): JSX.Element {
  const { client, live, detectLocalRunner } = Route.useRouteContext();
  const { sessionId } = Route.useParams();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const stored = settings.user.timezone ?? FALLBACK_TIMEZONE;
  const timezone = isSupportedTimezone(stored) ? stored : FALLBACK_TIMEZONE;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data.items;
  const profiles = useSuspenseQuery(profilesQuery(client)).data.items;
  const localRunnerId = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;

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
      instances={instances}
      runners={runners}
      profiles={profiles}
      localRunnerId={localRunnerId}
      settingsUser={settings.user}
    />
  );
}
