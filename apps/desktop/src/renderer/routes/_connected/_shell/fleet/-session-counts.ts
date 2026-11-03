import { useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { countRunnerSessions, type SessionCountsByRunner } from "@hercule/client-core/fleet";
import { fleetSessionsQuery } from "../../../../app/queries";
import { useWindowVisible } from "../../../../app/window-visibility";

/**
 * Returns how many sessions each runner holds, for the Fleet page and a
 * machine's page. The components get these counts and never the session list.
 *
 * - `select` is the module-level `countRunnerSessions`, so its identity never
 *   changes, and TanStack Query's structural sharing keeps the counts' identity
 *   while their values stay equal. A push that only changes a session's usage
 *   or last activity reads the list again but changes no count, so nothing
 *   that reads the counts renders again.
 * - While the window is hidden the query is not observed (`subscribed: false`).
 *   The shell keeps the `session` topic then, so pushes still mark the list out
 *   of date, but with no observer they read nothing. Showing the window
 *   observes the query again, and a list that a push marked out of date is read
 *   once. Without this, every push would read the whole list in a window
 *   nobody sees.
 */
export function useRunnerSessionCounts(client: HerculeClient): SessionCountsByRunner {
  const subscribed = useWindowVisible();
  return useSuspenseQuery({
    ...fleetSessionsQuery(client),
    select: countRunnerSessions,
    subscribed,
  }).data;
}
