import { useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { buildFleetFaces, type MachineFaces } from "@hercule/client-core/machine-work";
import { fleetSessionsQuery, runnersQuery } from "../../../../app/queries";
import { useRowMembers } from "../../../../app/session-presentation";
import { useWindowVisible } from "../../../../app/window-visibility";

/**
 * Returns the faces of the work on each machine, by runner id, for the Fleet
 * page's cards. A runner with no open session has no entry.
 *
 * - The faces are built in the query's `select`. TanStack Query keeps the
 *   identity of a selected result that is equal to the last one, and the faces
 *   hold no usage or last activity. A `session` push that changes only those
 *   reads the list again but draws nothing again.
 * - The rows' members come from the shell (`useRowMembers`), which keeps their
 *   identity while no row's key, title or lead changes. The sessions are
 *   grouped the way the sidebar groups them.
 * - While the window is hidden the query is not observed (`subscribed: false`),
 *   so a push reads nothing in a window nobody sees. See
 *   `useRunnerSessionCounts`.
 */
export function useMachineFaces(client: HerculeClient): Readonly<Record<string, MachineFaces>> {
  const rowMembers = useRowMembers();
  const { data: runners } = useSuspenseQuery(runnersQuery(client));
  const subscribed = useWindowVisible();
  return useSuspenseQuery({
    ...fleetSessionsQuery(client),
    select: (sessions) => buildFleetFaces({ sessions, rowMembers, runners }),
    subscribed,
  }).data;
}
