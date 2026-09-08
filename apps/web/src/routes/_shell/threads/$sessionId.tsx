import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { FALLBACK_TIMEZONE, isSupportedTimezone } from "@hydra/client-core";
import { sessionQuery, settingsQuery, transcriptQuery } from "../../../app/queries";
import { ThreadScreen } from "../../../screens/thread/thread-screen";

/**
 * A thread: `session.title` frames the top bar in place of this route's own
 * (there is no static one to give it - a thread's title is a record, not a
 * screen name), and the transcript is fetched before the route renders so the
 * first paint is never a spinner over an empty column.
 */
export const Route = createFileRoute("/_shell/threads/$sessionId")({
  loader: async ({ context, params }) => {
    const [session] = await Promise.all([
      context.queryClient.ensureQueryData(sessionQuery(context.client, params.sessionId)),
      context.queryClient.ensureQueryData(transcriptQuery(context.client, params.sessionId)),
    ]);
    return { title: session.title, crumb: `thread · ${params.sessionId.slice(0, 8)}` };
  },
  component: ThreadRoute,
});

function ThreadRoute(): JSX.Element {
  const { client, live } = Route.useRouteContext();
  const { sessionId } = Route.useParams();
  const stored = useSuspenseQuery(settingsQuery(client)).data.user.timezone ?? FALLBACK_TIMEZONE;
  const timezone = isSupportedTimezone(stored) ? stored : FALLBACK_TIMEZONE;

  // Keyed on the session: the router does not remount this component for a
  // param-only navigation, and this screen holds per-thread state (the live
  // tap's buffer, the seeded stream cursor) that must not carry over from the
  // thread just left to the one just opened.
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
