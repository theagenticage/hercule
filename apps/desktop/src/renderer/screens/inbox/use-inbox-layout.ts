import { useState } from "react";
import type { Inbox } from "@hercule/contract";
import {
  layOutInbox,
  NO_PLACEMENT,
  type InboxLayout,
  type InboxView,
  type VisitPlacement,
} from "@hercule/client-core/inbox";

/**
 * Returns the page for `inbox`, or `undefined` until the first read ends, and
 * keeps what the visit holds in place: the side, surface and group of each
 * card, and the order of the surfaces and groups (`layOutInbox`). A later read
 * changes the words on the page and adds new cards at the end, but moves no
 * card the user has seen. The held placement lives as long as the screen does:
 * leaving the Inbox and opening it again starts a new visit.
 *
 * `isFresh` is false while `inbox` is a copy kept from an earlier visit, which
 * stands in while this visit's own read is on its way. Such a copy is laid out
 * but is not held, because the visit's placement starts from its own reply.
 * It is true from then on.
 */
export const useInboxLayout = (
  inbox: Inbox | undefined,
  view: InboxView,
  isFresh: boolean,
): InboxLayout | undefined => {
  const [held, setHeld] = useState<VisitPlacement>(NO_PLACEMENT);
  const layout = inbox === undefined ? undefined : layOutInbox(inbox, view, held);
  // Set while drawing, so the draw that shows a new read already holds its cards.
  if (layout !== undefined && isFresh && layout.placement !== held) setHeld(layout.placement);
  return layout;
};
