import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { Inbox } from "@hercule/contract";
import { waitForStillHand } from "../../app/motion";
import { comeDownIntoPlace, flipInboxPage } from "./inbox-motion";

const NOTHING: ReadonlySet<string> = new Set();

/** Joins the ids of two sets, or returns `before` itself when `more` adds nothing. */
const addIds = (before: ReadonlySet<string>, more: readonly string[]): ReadonlySet<string> =>
  more.every((id) => before.has(id)) ? before : new Set([...before, ...more]);

/**
 * Decides what the Inbox page draws from what it reads, and plays the cards
 * that a read brings in, so nothing moves under the user's pointer.
 *
 * - A card the page has not drawn this visit is an arrival. The first read of
 *   a visit is drawn whole, with no motion. A card the user dismissed and put
 *   back is not an arrival, because the page drew it before.
 * - An arrival waits for a still hand (`waitForStillHand`, eight seconds at
 *   most): while the pointer rests on or near a card, the new card is not
 *   drawn, so nothing shifts under the pointer. Everything else a read changes
 *   is drawn at once, and so is every move of the user's own.
 * - Then the card comes down 20px and fades in on `self`, because nobody here
 *   caused it, and the cards that make room glide on `hand`.
 *
 * `inbox` is the Inbox with the user's pending edits applied. `isFresh` is
 * false while `inbox` is a copy kept from an earlier visit, which stands in
 * until this visit's own read ends: that copy is passed through, and the
 * visit's first reply is drawn whole, whatever it adds to it.
 *
 * Returns the Inbox to draw, or `undefined` until the first read ends, and
 * whether a card of the read is still held back. The page must not count the
 * read as shown while one is: its `counts.newestArrival` covers that card too.
 */
export const useInboxArrivals = ({
  inbox,
  isFresh,
  scrollRef,
}: {
  readonly inbox: Inbox | undefined;
  readonly isFresh: boolean;
  readonly scrollRef: RefObject<HTMLElement | null>;
}): { readonly inbox: Inbox | undefined; readonly hasHeldArrivals: boolean } => {
  const [drawnIds, setDrawnIds] = useState<ReadonlySet<string> | undefined>(undefined);
  const [released, setReleased] = useState(NOTHING);

  const arrivals =
    inbox === undefined || drawnIds === undefined || !isFresh
      ? []
      : inbox.cards
          .filter((card) => !drawnIds.has(card.id) && !released.has(card.id))
          .map((card) => card.id);
  // The effect below starts again only when the set of waiting cards changes.
  const arrivalKey = arrivals.join(" ");

  // The same object until a read or an edit changes it, because the screen compares it with the last.
  const drawn = useMemo(() => {
    if (inbox === undefined || arrivalKey === "") return inbox;
    const held = new Set(arrivalKey.split(" "));
    return { ...inbox, cards: inbox.cards.filter((card) => !held.has(card.id)) };
  }, [inbox, arrivalKey]);

  // What the page has drawn this visit, set while drawing so the draw that shows a card already counts it.
  if (drawn !== undefined && isFresh) {
    const ids = drawn.cards.map((card) => card.id);
    const known = addIds(drawnIds ?? NOTHING, ids);
    if (known !== drawnIds) setDrawnIds(known);
  }

  const latestArrivals = useRef(arrivals);
  useEffect(() => {
    latestArrivals.current = arrivals;
  });
  useEffect(() => {
    if (arrivalKey === "") return;
    const wait = new AbortController();
    void waitForStillHand({
      // The card the pointer rests on is the one that must not move.
      targets: () => [...(scrollRef.current?.querySelectorAll('[data-current="pointer"]') ?? [])],
      isDragging: () => false,
      signal: wait.signal,
    }).then((isStill) => {
      if (!isStill) return;
      const letIn = (): void => {
        flushSync(() => {
          setReleased((before) => addIds(before, latestArrivals.current));
        });
      };
      const scroller = scrollRef.current;
      if (scroller === null) {
        letIn();
        return;
      }
      const { born } = flipInboxPage(scroller, "hand", letIn);
      for (const card of born) {
        if (card.dataset["cardId"] !== undefined) comeDownIntoPlace(card);
      }
    });
    return () => {
      wait.abort();
    };
  }, [arrivalKey, scrollRef]);

  return { inbox: drawn, hasHeldArrivals: arrivalKey !== "" };
};
