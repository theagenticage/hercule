import { useState } from "react";
import type { Inbox } from "@hercule/contract";
import {
  HOME_GROUPING,
  keepHeldGrouping,
  listInboxGroupings,
  type InboxGrouping,
} from "@hercule/client-core/inbox";

/** The Group by menu of a page that has not been read: Place alone, so the toolbar keeps its shape. */
const GROUPINGS_BEFORE_READ: readonly InboxGrouping[] = [{ id: HOME_GROUPING, name: "Place" }];

/**
 * Returns the rows of the Group by menu for `inbox`. `heldGrouping` is the
 * grouping the page is laid out with, which can be a kind of place that a
 * later read no longer offers: the menu keeps it as a row for the visit, under
 * the name it had when it was offered, so the toolbar names what the page shows.
 */
export const useInboxGroupings = (
  inbox: Inbox | undefined,
  heldGrouping: string | undefined,
): readonly InboxGrouping[] => {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  if (inbox === undefined) return GROUPINGS_BEFORE_READ;
  const offered = listInboxGroupings(inbox);
  // Set while drawing, so the draw that stops offering a kind already knows its name.
  if (offered.some((each) => names.get(each.id) !== each.name)) {
    setNames(new Map([...names, ...offered.map((each) => [each.id, each.name] as const)]));
  }
  const heldName = heldGrouping === undefined ? undefined : names.get(heldGrouping);
  return keepHeldGrouping(
    offered,
    heldGrouping === undefined || heldName === undefined
      ? undefined
      : { id: heldGrouping, name: heldName },
  );
};
