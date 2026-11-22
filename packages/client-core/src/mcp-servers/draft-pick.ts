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
 * The list may name a server deleted since the pick: `buildSubmission` drops
 * those when it is sent.
 */
export const resolveDraftMcpServerIds = (
  picks: ThreadPicks,
  projectId: string | null,
): readonly string[] | undefined => {
  const pick = picks.mcpServers;
  return pick === undefined || pick.projectId !== projectId ? undefined : pick.mcpServerIds;
};
