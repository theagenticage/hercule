import { useState } from "react";
import { EMPTY_FILTER, type Filter } from "@hercule/client-core/desk";
import type { RequestsOrder } from "@hercule/client-core/inbox";
import { readSavedInboxView, writeSavedInboxView } from "./inbox-view-storage";

/** How the user looks at the Inbox: what `useInboxView` returns. */
export interface InboxViewChoices {
  readonly grouping: string;
  readonly setGrouping: (grouping: string) => void;
  readonly requestsOrder: RequestsOrder;
  readonly setRequestsOrder: (order: RequestsOrder) => void;
  readonly filter: Filter;
  readonly setFilter: (filter: Filter) => void;
}

/**
 * Holds the client state of the Inbox's toolbar: what the wide side is
 * grouped by, how Requests are ordered, and the filter. The grouping and the
 * order are kept in `localStorage` under `storageKey` (see
 * `inbox-view-storage.ts`). The filter is not: it is about what the user is
 * doing now.
 */
export const useInboxView = (storageKey: string): InboxViewChoices => {
  const [saved, setSaved] = useState(() => readSavedInboxView(storageKey));
  const [filter, setFilter] = useState<Filter>(EMPTY_FILTER);
  return {
    grouping: saved.grouping,
    setGrouping: (grouping) => {
      const next = { ...saved, grouping };
      setSaved(next);
      writeSavedInboxView(storageKey, next);
    },
    requestsOrder: saved.requestsOrder,
    setRequestsOrder: (requestsOrder) => {
      const next = { ...saved, requestsOrder };
      setSaved(next);
      writeSavedInboxView(storageKey, next);
    },
    filter,
    setFilter,
  };
};
