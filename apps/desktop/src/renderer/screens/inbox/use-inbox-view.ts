import { useEffect, useMemo, useState } from "react";
import { EMPTY_FILTER, type Filter } from "@hercule/client-core/desk";
import type { RequestsGrouping, RequestsShow, RequestsSort } from "@hercule/client-core/inbox";
import { readSavedInboxView, writeSavedInboxView, type SavedInboxView } from "./inbox-view-storage";

/** How the user looks at the Inbox: what `useInboxView` returns. */
export interface InboxViewChoices {
  readonly grouping: string;
  readonly setGrouping: (grouping: string) => void;
  readonly filter: Filter;
  readonly setFilter: (filter: Filter) => void;
  readonly requestsShow: RequestsShow;
  readonly setRequestsShow: (show: RequestsShow) => void;
  readonly requestsGrouping: RequestsGrouping;
  readonly setRequestsGrouping: (grouping: RequestsGrouping) => void;
  readonly requestsSort: RequestsSort;
  readonly setRequestsSort: (sort: RequestsSort) => void;
  /** The ids of the Requests groups the user folded (`RequestGroup.id`). */
  readonly collapsedGroups: ReadonlySet<string>;
  /** Folds the group `id` when it is open, and opens it when it is folded. */
  readonly toggleGroup: (id: string) => void;
}

const isSameShow = (a: RequestsShow, b: RequestsShow): boolean =>
  a.kind === b.kind && (a.kind !== "person" || (b.kind === "person" && a.name === b.name));

/**
 * Holds the client state of the Inbox's toolbar: what the wide side is
 * grouped by, which Requests are shown, how the Requests column is grouped
 * and sorted, which of its groups are folded, and the page filter. All but
 * the filter are kept in `localStorage` under `storageKey` (see
 * `inbox-view-storage.ts`); the filter is about what the user is doing now.
 *
 * `requestsShow` keeps its object identity until the choice changes, and
 * `collapsedGroups` its identity until a group is toggled, so the page does
 * not lay out again for a choice that stayed the same.
 */
export const useInboxView = (storageKey: string): InboxViewChoices => {
  const [saved, setSaved] = useState(() => readSavedInboxView(storageKey));
  const [filter, setFilter] = useState<Filter>(EMPTY_FILTER);

  // Writing on mount is intended: it rewrites an entry saved by an older build in the current shape.
  useEffect(() => writeSavedInboxView(storageKey, saved), [storageKey, saved]);

  // The new view is computed from the latest one, so two changes in one batch both land.
  // An update that returns its argument unchanged keeps the state, and so skips the write.
  const change = (update: (view: SavedInboxView) => SavedInboxView): void => setSaved(update);

  const collapsedGroups = useMemo(() => new Set(saved.collapsedGroups), [saved.collapsedGroups]);

  return {
    grouping: saved.grouping,
    setGrouping: (grouping) =>
      change((view) => (view.grouping === grouping ? view : { ...view, grouping })),
    filter,
    setFilter,
    requestsShow: saved.requestsShow,
    setRequestsShow: (requestsShow) =>
      change((view) =>
        isSameShow(view.requestsShow, requestsShow) ? view : { ...view, requestsShow },
      ),
    requestsGrouping: saved.requestsGrouping,
    setRequestsGrouping: (requestsGrouping) =>
      change((view) =>
        view.requestsGrouping === requestsGrouping ? view : { ...view, requestsGrouping },
      ),
    requestsSort: saved.requestsSort,
    setRequestsSort: (requestsSort) =>
      change((view) => (view.requestsSort === requestsSort ? view : { ...view, requestsSort })),
    collapsedGroups,
    toggleGroup: (id) =>
      change((view) => ({
        ...view,
        collapsedGroups: view.collapsedGroups.includes(id)
          ? view.collapsedGroups.filter((folded) => folded !== id)
          : [...view.collapsedGroups, id],
      })),
  };
};
