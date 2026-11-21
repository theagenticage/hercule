import type { ThreadPicks } from "../threads/config";

/**
 * Returns the list a Draft Thread sends as `mcpServerIds`, or `undefined`
 * when the user has not changed the list, so the draft sends none and a
 * default changed meanwhile still applies.
 *
 * The pick holds the project it was made under, and applies only while the
 * draft is in that project. A list chosen for one project must not decide the
 * servers of a thread started in another. An explicit empty list stays
 * empty: it is the user's choice of no servers.
 *
 * Ids not in `knownServerIds` (a server deleted since the pick) are dropped,
 * as the controller drops them from every list it stores. `knownServerIds`
 * is `undefined` while the list of servers has not been read, and then
 * nothing is dropped.
 */
export const resolveDraftMcpServerIds = (
  picks: ThreadPicks,
  projectId: string | null,
  knownServerIds: ReadonlySet<string> | undefined,
): readonly string[] | undefined => {
  const pick = picks.mcpServers;
  if (pick === undefined || pick.projectId !== projectId) return undefined;
  return knownServerIds === undefined
    ? pick.mcpServerIds
    : pick.mcpServerIds.filter((id) => knownServerIds.has(id));
};
