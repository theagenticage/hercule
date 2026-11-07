import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  advanceInboxVisit,
  advanceLinkGesture,
  START_OF_VISIT,
  type InboxVisit,
  type LinkGestureStep,
  type VisitHistory,
  type VisitStep,
} from "@hercule/client-core/inbox";
import { waitForStillHand } from "../../app/motion";
import { addIds, NO_IDS } from "./card-ids";
import { comeDownIntoPlace, flipInboxPage } from "./inbox-motion";
import { useSignalLanding } from "./use-signal-landing";

/** How long the sunrise waits after the user's own move empties the Inbox, which is the time the last card takes to step aside. */
const SUNRISE_DELAY_MS = 320;

/** What the visit remembers, shared by the hook that draws the page and the one that makes the user's moves. */
export interface VisitHistoryHandle {
  readonly history: VisitHistory;
  /** Replaces the history, as `advanceInboxVisit` returns it for the draw. */
  readonly setHistory: (history: VisitHistory) => void;
  /** Returns the newest history, also when it was changed after the last draw. A move planned later reads it. */
  readonly readLatest: () => VisitHistory;
  /** Follows a Link or Unlink of the user from its start to the controller's answer (`advanceLinkGesture`). */
  readonly advanceLinkGesture: (step: LinkGestureStep) => void;
}

/**
 * Returns the history of the visit of this screen (`START_OF_VISIT` at first).
 * `useInboxVisit` draws from it and `useInboxMoves` makes the user's Links and
 * Unlinks in it, so the visit is the one place that knows where a card rides.
 */
export const useVisitHistory = (): VisitHistoryHandle => {
  const [history, setHistoryState] = useState(START_OF_VISIT);
  const latest = useRef(history);
  useLayoutEffect(() => {
    latest.current = history;
  });
  return {
    history,
    setHistory: setHistoryState,
    readLatest: () => latest.current,
    advanceLinkGesture: (step) => {
      latest.current = advanceLinkGesture(latest.current, step);
      setHistoryState((before) => advanceLinkGesture(before, step));
    },
  };
};

/**
 * Returns what the Inbox page draws for the read it holds (`InboxVisit`), and
 * plays what the visit lets in, so nothing moves under the user's pointer.
 * The rules of the visit are `advanceInboxVisit`'s. The visit lives as long as
 * the screen does: leaving the Inbox and opening it again starts a new one.
 *
 * - An arrival waits for a still hand (`waitForStillHand`, eight seconds at
 *   most): while the pointer rests on or near a card, the new card is not
 *   drawn. Everything else a read changes is drawn at once, and so is every
 *   move of the user's own.
 * - Then the card comes down 20px and fades in on `self`, because nobody here
 *   caused it, and the cards that make room glide on `hand`.
 * - When the user's own move empties the Inbox, `isWaitingForSunrise` holds
 *   the all-clear back for the time the last card takes to step aside.
 * - A signal that lands on a card since the visit's first read is played by
 *   `useSignalLanding`: its drop falls first, and the card's new words are
 *   drawn when it lands. The card is then fresh (`freshIds`) until the pointer
 *   or the keys reach it, or it opens (`clearFresh`). A card that is new to
 *   the page is an arrival, not fresh. `announcement` is what a screen reader
 *   says for the signals that landed.
 *
 * `step` is the read as `VisitStep` describes it, without the ids released so
 * far, which this hook keeps. `visit` is the history this hook advances. `scrollRef`
 * is the element that scrolls the page.
 */
export const useInboxVisit = ({
  step,
  visit: { history, setHistory },
  scrollRef,
}: {
  readonly step: Omit<VisitStep, "released">;
  readonly visit: VisitHistoryHandle;
  readonly scrollRef: RefObject<HTMLElement | null>;
}): InboxVisit & {
  readonly isWaitingForSunrise: boolean;
  readonly freshIds: ReadonlySet<string>;
  readonly clearFresh: (id: string) => void;
  readonly announcement: string;
} => {
  const [released, setReleased] = useState(NO_IDS);
  // A signal that lands holds its card's old words back for a moment, so the read drawn is not always the latest.
  const landing = useSignalLanding({
    received: step.received,
    isFresh: step.isFresh,
    scrollRef,
  });

  // Laying out the page is the costly part of a draw, so it runs again only for a different read or choice.
  const { view, isFresh, hasUserMove } = step;
  const { grouping, filter, requestsOrder } = view;
  const next = useMemo(
    () =>
      advanceInboxVisit(history, {
        received: landing.inbox,
        view: { grouping, filter, requestsOrder },
        released,
        isFresh,
        hasUserMove,
      }),
    [history, landing.inbox, grouping, filter, requestsOrder, released, isFresh, hasUserMove],
  );
  // Set while drawing, so the draw that shows a new read already holds its cards.
  if (next.history !== history) setHistory(next.history);
  const { visit } = next;

  const latestArrivals = useRef(visit.heldArrivals);
  useEffect(() => {
    latestArrivals.current = visit.heldArrivals;
  });
  // The effect below starts again only when the set of waiting cards changes.
  const arrivalKey = visit.heldArrivals.join(" ");
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

  const isEmptiedByMove = visit.emptiedByMove.everything;
  const [hasWaitedForSunrise, setHasWaitedForSunrise] = useState(false);
  useEffect(() => {
    if (!isEmptiedByMove) return;
    const timer = setTimeout(() => {
      setHasWaitedForSunrise(true);
    }, SUNRISE_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [isEmptiedByMove]);
  if (!isEmptiedByMove && hasWaitedForSunrise) setHasWaitedForSunrise(false);

  return {
    ...visit,
    isWaitingForSunrise: isEmptiedByMove && !hasWaitedForSunrise,
    freshIds: landing.freshIds,
    clearFresh: landing.clearFresh,
    announcement: landing.announcement,
  };
};
