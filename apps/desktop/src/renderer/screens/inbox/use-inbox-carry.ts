import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createInboxCarry, type CarryView, type InboxCarryOptions } from "./inbox-carry";
import type { RailTarget } from "./rail";

/** What `useInboxCarry` is given: the options of the carry, and the element that holds the cards. */
export interface UseInboxCarryOptions extends InboxCarryOptions {
  /**
   * The element that holds every card and stays mounted for the life of the
   * screen: the one that scrolls. It receives the press and holds the pointer,
   * and its closest `.inbox-desk` holds the layer of the card in the hand.
   */
  readonly pageRef: RefObject<HTMLElement | null>;
}

/** What `useInboxCarry` returns for the page to draw. */
export interface InboxCarry {
  /**
   * The rail to draw, or `null` when there is none. It is drawn from the lift
   * until the rail has left after a drop, which is a little after the card is
   * let go. The page draws `<Rail ref={attachRail} targets={rail.targets} monogram={monogram} />`.
   */
  readonly rail: { readonly cardId: string; readonly targets: readonly RailTarget[] } | null;
  /** The ref for the rail's element, which the carry moves. */
  readonly attachRail: (element: HTMLDivElement | null) => void;
  /**
   * Whether a card is in the hand, from the lift to the moment it is let go.
   * The page holds back every change nobody asked for while it is true.
   */
  readonly isCarrying: boolean;
}

/**
 * Lets the user carry a card of the Inbox with the pointer. A press that moves
 * 6px or less is a click, and opens the card as before. Past that, the card
 * lifts: a copy follows the pointer, the card's place stays open, and the rail
 * of `readRailTargets(cardId)` rises. Letting go:
 *
 * - near a rail target (within 96px, which pulls the card in) calls
 *   `onDropOnTarget`;
 * - over another card, whose edge lights, calls `onDropOnCard`;
 * - anywhere else, or Esc, a cancelled pointer or a window that lost the focus,
 *   sends the card home and calls nothing.
 *
 * A press on a button, link, menu or field starts no carry, nor does a card
 * `canCarry` refuses, nor any press while `disabled`. The click that ends a
 * carry is swallowed. The hook never calls the API.
 *
 * The page draws the rail (`rail`), and holds back every change nobody
 * asked for while `isCarrying`.
 */
export function useInboxCarry(options: UseInboxCarryOptions): InboxCarry {
  const latest = useRef<InboxCarryOptions>(options);
  // A layout effect, so the controller reads the options of the page it sees.
  useLayoutEffect(() => {
    latest.current = options;
  });
  const railElement = useRef<HTMLDivElement | null>(null);
  const attachRail = useCallback((element: HTMLDivElement | null): void => {
    railElement.current = element;
  }, []);
  const [view, setView] = useState<CarryView | null>(null);
  const { pageRef } = options;
  useEffect(() => {
    const page = pageRef.current;
    if (page === null) return;
    return createInboxCarry({
      page,
      readOptions: () => latest.current,
      readRail: () => railElement.current,
      publish: setView,
    }).destroy;
  }, [pageRef]);
  return {
    rail: view === null ? null : { cardId: view.cardId, targets: view.targets },
    attachRail,
    isCarrying: view?.isHeld === true,
  };
}
