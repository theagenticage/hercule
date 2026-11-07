import { useEffect, useRef, type RefObject } from "react";
import { useScreenWatcher } from "../../app/screen-watcher";

/** The attribute `card.css` reads to pause a card's paws while the card is scrolled out of view. */
const OFFSCREEN_ATTRIBUTE = "data-offscreen";

/** Matches the paws of a colleague who is typing. A still colleague has no animation to pause. */
const WORKING_PAWS = '.card-paws[data-pose="working"]:not([data-still])';

/**
 * Pauses the paws of every working colleague whose card is scrolled out of
 * view in `scrollRef`, so a long board does not animate what nobody sees.
 *
 * - It watches only cards that have a colleague at work. With none, no
 *   observer is made, and none runs.
 * - The board shares one IntersectionObserver (`useScreenWatcher`). A card
 *   that leaves the screen gets `data-offscreen`, and loses it on returning.
 *   No React state changes, so no card renders again.
 * - Cards come and go with every change of the board, so the list of watched
 *   cards is checked after each commit of the calling component.
 */
export const usePausePawsOffScreen = (scrollRef: RefObject<HTMLElement | null>): void => {
  const watchScreen = useScreenWatcher(scrollRef);
  const watched = useRef(new Map<Element, () => void>());

  // No dependency list: a card can start or stop working, or leave the page,
  // without anything this hook could name changing.
  useEffect(() => {
    const working = new Set<Element>();
    for (const paws of scrollRef.current?.querySelectorAll(WORKING_PAWS) ?? []) {
      const card = paws.closest(".desk-card");
      if (card !== null) working.add(card);
    }
    for (const [card, stop] of watched.current) {
      if (working.has(card)) continue;
      stop();
      card.removeAttribute(OFFSCREEN_ATTRIBUTE);
      watched.current.delete(card);
    }
    for (const card of working) {
      if (watched.current.has(card)) continue;
      watched.current.set(
        card,
        watchScreen(card, (isOnScreen) => {
          card.toggleAttribute(OFFSCREEN_ATTRIBUTE, !isOnScreen);
        }),
      );
    }
  });

  useEffect(() => {
    const stops = watched.current;
    return () => {
      for (const stop of stops.values()) stop();
      stops.clear();
    };
  }, []);
};
