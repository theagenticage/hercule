/**
 * What the Inbox list is on, and the query it reads for it. The scope is the
 * rail's entry: a saved query, or a Browse value. The search narrows it.
 */
import type { InboxSearch } from "@hercule/client-core/inbox";
import type { InboxCounts, InboxList, InboxQuery } from "@hercule/contract";
import type { RailEntry } from "../../../screens/inbox/inbox-rail";

/** The id of the saved query the Inbox opens on: the things someone waits on the user for. */
export const DEFAULT_INBOX_QUERY_ID = "waits";

/** The scope the Inbox opens on. */
export const DEFAULT_INBOX_SCOPE: RailEntry = { kind: "saved-query", id: DEFAULT_INBOX_QUERY_ID };

/** The id of the saved query that holds everything, which the search widens to. */
export const EVERYTHING_QUERY_ID = "everything";

/** The scope a search widens to. */
export const EVERYTHING_INBOX_SCOPE: RailEntry = { kind: "saved-query", id: EVERYTHING_QUERY_ID };

/** Returns the list a scope reads: a saved query by its id, or the one clause a Browse value sends. */
export const buildInboxList = (scope: RailEntry): InboxList =>
  scope.kind === "saved-query"
    ? { savedQuery: scope.id }
    : {
        browse: {
          key: scope.value.key,
          op: "is",
          value: scope.value.value,
          source: scope.value.source,
          ...(scope.value.connectionId === undefined
            ? {}
            : { connectionId: scope.value.connectionId }),
        },
      };

/** Returns the first-page query of a scope and the search over it. */
export const buildInboxQuery = (scope: RailEntry, search: InboxSearch): InboxQuery => ({
  list: buildInboxList(scope),
  clauses: [...search.clauses],
  text: search.text,
});

/** Returns whether the search narrows the scope at all. */
export const isSearching = (search: InboxSearch): boolean =>
  search.clauses.length > 0 || search.text.trim() !== "";

/**
 * Returns the name of a scope for the list head and the search's scope token:
 * a saved query's name, else the label of the Browse value (a pin or a facet
 * value of the counts), else the value as it was sent.
 */
export const nameInboxScope = (scope: RailEntry, counts: InboxCounts): string => {
  if (scope.kind === "saved-query") {
    return counts.savedQueries.find((query) => query.id === scope.id)?.name ?? scope.id;
  }
  const { value } = scope;
  const isValue = (each: { source?: string; connectionId?: string; key: string; value: string }) =>
    each.source === value.source && each.key === value.key && each.value === value.value;
  const pinned = counts.pins.find(isValue);
  if (pinned !== undefined) return pinned.label;
  for (const source of counts.sources) {
    for (const facet of source.facets ?? []) {
      const item = facet.values.find(
        (each) =>
          source.source === value.source && facet.key === value.key && each.value === value.value,
      );
      if (item !== undefined) return item.label;
    }
  }
  return value.value;
};
