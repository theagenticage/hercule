/**
 * The rule for a list of MCP Servers, whichever list it is (a thread's, a
 * project's, the default list): it never holds two servers of one name,
 * because their tools would get the same names (spec 21 section 4.1). Two
 * Sentry accounts are both named `sentry`, so a list holds one of them.
 */
import type { McpServer } from "@hercule/contract";
import type { McpServerView } from "./views";

/**
 * A server as the rule of one name per list sees it: its id and its name.
 * Both come from the server record, so a decision needs neither the
 * Connections nor the plugins that a joined view carries.
 */
export type NamedServer = Pick<McpServer, "id" | "name">;

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
 * Returns the id in `ids` of a server named `name` that the caller did not
 * expect there, or `undefined` when the name's slot in the list is free or
 * held by a server the caller expected. This is the one rule of the slot of a
 * name, for a press on a name and for a press on a box alike.
 *
 * `expectedIds` are the servers the caller is placing or replacing: the
 * server the user asked for, and the one the user saw in the slot. A list
 * that names any other server of `name` holds the slot for someone the user
 * did not decide about.
 */
export const findOtherOccupant = (
  ids: readonly string[],
  servers: readonly NamedServer[],
  name: string,
  expectedIds: readonly string[],
): string | undefined =>
  ids.find(
    (id) =>
      !expectedIds.includes(id) &&
      servers.some((server) => server.id === id && server.name === name),
  );

/**
 * Returns `ids` with the servers named `name` replaced by `serverId`, or
 * with none of them when `serverId` is `null`. So one call switches a name
 * on with one account, switches it off, or swaps its account, and the result
 * never holds two servers of one name.
 *
 * A swap puts the new id where the old one was, so it does not reorder the
 * list. A name switched on with none before is appended.
 *
 * Ids that no server knows are kept as they are: a server the thread has but
 * the catalogue has not read yet must not be erased by an unrelated write. A
 * list that names a server since deleted is refused by the controller, which
 * the user sees. A `serverId` that is not a server of `name` returns the list
 * unchanged: it is not a request to switch the name off.
 */
export const chooseNamedServer = (
  ids: readonly string[],
  servers: readonly NamedServer[],
  name: string,
  serverId: string | null,
): string[] => {
  const sameName = new Set(
    servers.filter((server) => server.name === name).map((server) => server.id),
  );
  if (serverId === null) return ids.filter((id) => !sameName.has(id));
  if (!sameName.has(serverId)) return [...ids];
  const first = ids.findIndex((id) => sameName.has(id));
  const others = ids.filter((id) => !sameName.has(id));
  if (first === -1) return [...others, serverId];
  // Count the ids before the old one that stay, to find its place among them.
  const place = ids.slice(0, first).filter((id) => !sameName.has(id)).length;
  return [...others.slice(0, place), serverId, ...others.slice(place)];
};
