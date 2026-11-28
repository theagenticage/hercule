import { useEffect, type RefObject } from "react";
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
 *   intersection observer is made.
 * - The board shares one IntersectionObserver (`useScreenWatcher`). A card
 *   that leaves the screen gets `data-offscreen`, and loses it on returning.
 *   No React state changes, so no card renders again.
 * - Cards come and go with the board, and a colleague starts or stops
 *   working. A mutation observer on the board tells the hook when that
 *   happens, so the list of watched cards is checked then and not on every
 *   render of the calling component.
 */
export const usePausePawsOffScreen = (scrollRef: RefObject<HTMLElement | null>): void => {
  const watchScreen = useScreenWatcher(scrollRef);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const watched = new Map<Element, () => void>();

    const syncWatchedCards = (): void => {
      const working = new Set<Element>();
      for (const paws of scroller.querySelectorAll(WORKING_PAWS)) {
        const card = paws.closest(".desk-card");
        if (card !== null) working.add(card);
      }
      for (const [card, stop] of watched) {
        if (working.has(card)) continue;
        stop();
        card.removeAttribute(OFFSCREEN_ATTRIBUTE);
        watched.delete(card);
      }
      for (const card of working) {
        if (watched.has(card)) continue;
        watched.set(
          card,
          watchScreen(card, (isOnScreen) => {
            card.toggleAttribute(OFFSCREEN_ATTRIBUTE, !isOnScreen);
          }),
        );
      }
    };

    syncWatchedCards();
    const observer = new MutationObserver(syncWatchedCards);
    observer.observe(scroller, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-pose", "data-still"],
    });
    return () => {
      observer.disconnect();
      for (const stop of watched.values()) stop();
      watched.clear();
    };
  }, [scrollRef, watchScreen]);
};
