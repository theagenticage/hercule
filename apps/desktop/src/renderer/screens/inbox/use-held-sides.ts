import { useState } from "react";
import type { Inbox, InboxSide } from "@hercule/contract";
import { holdInboxSides } from "@hercule/client-core/inbox";

/**
 * Returns the side of each card as the visit first saw it, so a card that
 * gets a Task keeps its place until the user comes back (`holdInboxSides`).
 * The map lives as long as the screen does: leaving the Inbox and opening it
 * again starts a new visit, which reads the sides afresh.
 *
 * `inbox` is `undefined` until the first read ends.
 */
export const useHeldSides = (inbox: Inbox | undefined): ReadonlyMap<string, InboxSide> => {
  const [held, setHeld] = useState<ReadonlyMap<string, InboxSide>>(new Map());
  const [heldFrom, setHeldFrom] = useState<Inbox | undefined>(undefined);
  // Set while drawing, so the draw that shows a new read already holds its cards.
  if (inbox !== heldFrom) {
    setHeldFrom(inbox);
    if (inbox !== undefined) setHeld(holdInboxSides(held, inbox));
  }
  return held;
};
