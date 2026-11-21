/**
 * The rule for a list of MCP Servers, whichever list it is (a thread's, a
 * project's, the default list): it never holds two servers of one name,
 * because their tools would get the same names (spec 21 section 4.1). Two
 * Sentry accounts are both named `sentry`, so a list holds one of them.
 */
import type { McpServerView } from "./views";

/** The servers that share one name. A screen draws it as one row with a choice of account. */
export interface ServerNameGroup {
  readonly name: string;
  /** One view for each account, sorted by the account's label. */
  readonly views: readonly McpServerView[];
}

/**
 * Returns `views` grouped by server name, in the order each name first
 * appears in `views`. Within a group the views are sorted by account label,
 * so the choice of account always lists them in the same order.
 */
export const groupServersByName = (views: readonly McpServerView[]): ServerNameGroup[] => {
  const groups = new Map<string, McpServerView[]>();
  for (const view of views) {
    const group = groups.get(view.server.name);
    if (group === undefined) groups.set(view.server.name, [view]);
    else group.push(view);
  }
  return [...groups].map(([name, grouped]) => ({
    name,
    views: grouped.toSorted((a, b) => (a.account ?? "").localeCompare(b.account ?? "")),
  }));
};

/**
 * Returns `ids` with the servers named `name` replaced by `serverId`, or
 * with none of them when `serverId` is `null`. So one call switches a name
 * on with one account, switches it off, or swaps its account, and the result
 * never holds two servers of one name.
 *
 * A swap puts the new id where the old one was, so it does not reorder the
 * list. A name switched on with none before is appended.
 *
 * Ids that no view knows (a server deleted since the list was read) are
 * dropped, because a list that names one is refused. A `serverId` that is not
 * a server of that name is ignored, which leaves the name off.
 */
export const chooseNamedServer = (
  ids: readonly string[],
  views: readonly McpServerView[],
  name: string,
  serverId: string | null,
): string[] => {
  const sameName = new Set(
    views.filter((view) => view.server.name === name).map((view) => view.server.id),
  );
  const known = new Set(views.map((view) => view.server.id));
  const kept = ids.filter((id) => known.has(id));
  if (serverId === null || !sameName.has(serverId)) return kept.filter((id) => !sameName.has(id));
  const first = kept.findIndex((id) => sameName.has(id));
  const others = kept.filter((id) => !sameName.has(id));
  if (first === -1) return [...others, serverId];
  // Count the ids before the old one that stay, to find its place among them.
  const place = kept.slice(0, first).filter((id) => !sameName.has(id)).length;
  return [...others.slice(0, place), serverId, ...others.slice(place)];
};
