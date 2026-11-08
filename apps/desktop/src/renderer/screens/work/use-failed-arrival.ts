import { useEffect, useEffectEvent, useRef, type RefObject } from "react";
import type { Filter } from "@hercule/client-core/desk";
import { FAILED_FILTER, type CardInLane } from "@hercule/client-core/work";
import { readCardInLane } from "./card-in-lane";
import { keepCardInView } from "./keep-in-view";

/**
 * Shows what failed when Work is opened from the sidebar's failed-run dot:
 * once `isRequested` turns true, it puts the Failed filter on, clears the
 * Find text, and tells the caller with `onArrived` so that the address drops
 * the request. Once the board is on screen (`hasBoard`) with that filter on,
 * it scrolls the first card into view and makes it the current card.
 *
 * `filter` is the filter in use now, and `scrollRef` is the board's scroller.
 * The filter lifts itself when no card has failed any more (see
 * `dropEmptyValues`). Then the filter is no longer the one this hook set, so
 * there is no card to scroll to, which is fine.
 */
export function useFailedArrival({
  isRequested,
  hasBoard,
  filter,
  scrollRef,
  setFilter,
  setFindText,
  setCurrentCard,
  onArrived,
}: {
  readonly isRequested: boolean;
  readonly hasBoard: boolean;
  readonly filter: Filter;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly setFilter: (filter: Filter) => void;
  readonly setFindText: (text: string) => void;
  readonly setCurrentCard: (card: CardInLane | null) => void;
  readonly onArrived: () => void;
}): void {
  const isWaitingToReveal = useRef(false);

  const arrive = useEffectEvent(() => {
    isWaitingToReveal.current = true;
    setFilter(FAILED_FILTER);
    setFindText("");
    onArrived();
  });
  useEffect(() => {
    if (isRequested) arrive();
  }, [isRequested]);

  // It runs after every draw, not on a list of changes, because the draw that
  // shows the filter is not always a change of anything this hook is given:
  // a second request finds the filter on already.
  useEffect(() => {
    if (!isWaitingToReveal.current || !hasBoard || filter !== FAILED_FILTER) return;
    isWaitingToReveal.current = false;
    const scroller = scrollRef.current;
    const element = scroller?.querySelector<HTMLElement>("[data-card-id]");
    const at = element === null || element === undefined ? null : readCardInLane(element);
    if (scroller === null || element === null || element === undefined || at === null) return;
    keepCardInView(scroller, element);
    setCurrentCard(at);
  });
}
