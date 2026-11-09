import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import {
  advanceInboxVisit,
  advanceLanding,
  advanceLinkGesture,
  START_OF_VISIT,
  type InboxVisit,
  type LandingStep,
  type LinkGestureStep,
  type VisitHistory,
  type VisitStep,
} from "@hercule/client-core/inbox";
import { isMotionReduced, waitForStillHand } from "../../app/motion";
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
  /**
   * Follows a landing from the drop to the user reaching the card
   * (`advanceLanding`), and returns the ids of the cards the step released.
   * Stable, because effects depend on it.
   */
  readonly advanceLanding: (step: LandingStep) => readonly string[];
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
  const advanceLandingStep = useCallback((step: LandingStep): readonly string[] => {
    const advanced = advanceLanding(latest.current, step);
    latest.current = advanced.history;
    setHistoryState((before) => advanceLanding(before, step).history);
    return advanced.released;
  }, []);
  return {
    history,
    setHistory: setHistoryState,
    readLatest: () => latest.current,
    advanceLinkGesture: (step) => {
      latest.current = advanceLinkGesture(latest.current, step);
      setHistoryState((before) => advanceLinkGesture(before, step));
    },
    advanceLanding: advanceLandingStep,
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
 * - A signal that lands on a card since the visit's first read is decided by
 *   the visit and played by `useSignalLanding`: its drop falls first, and the
 *   card's new words are drawn when it lands. The card is then fresh
 *   (`freshIds`) until the pointer or the keys reach it, or it opens
 *   (`clearFresh`). A card that is new to the page is an arrival, not fresh.
 *   `announcement` is what a screen reader says for the signals that landed.
 *
 * `step` is the read as `VisitStep` describes it, without the ids released so
 * far, which this hook keeps, and without the Reduce motion question, which it
 * asks. `visit` is the history this hook advances. `scrollRef` is the element
 * that scrolls the page. `isCarrying` tells whether the user holds a card in
 * the hand: a card that arrives waits for as long as it is true.
 */
export const useInboxVisit = ({
  step,
  visit: { history, setHistory, advanceLanding: advanceLandingStep },
  scrollRef,
  isCarrying,
}: {
  readonly step: Omit<VisitStep, "released" | "isMotionReduced">;
  readonly visit: VisitHistoryHandle;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly isCarrying: () => boolean;
}): Omit<InboxVisit, "landing"> & {
  readonly isWaitingForSunrise: boolean;
  readonly clearFresh: (id: string) => void;
} => {
  const [released, setReleased] = useState(NO_IDS);

  // Laying out the page is the costly part of a draw, so it runs again only for a different read or choice.
  const { received, view, isFresh, hasUserMove } = step;
  const { grouping, filter, requestsGrouping, requestsShow, requestsSort } = view;
  const next = useMemo(
    () =>
      advanceInboxVisit(history, {
        received,
        view: { grouping, filter, requestsGrouping, requestsShow, requestsSort },
        released,
        isFresh,
        hasUserMove,
        isMotionReduced,
      }),
    [
      history,
      received,
      grouping,
      filter,
      requestsGrouping,
      requestsShow,
      requestsSort,
      released,
      isFresh,
      hasUserMove,
    ],
  );
  // Set while drawing, so the draw that shows a new read already holds its cards.
  if (next.history !== history) setHistory(next.history);
  const { landing, ...visit } = next.visit;
  useSignalLanding({ landing, scrollRef, advanceLanding: advanceLandingStep });
  // Stable, because the screen depends on it in an effect.
  const clearFresh = useCallback(
    (id: string): void => {
      advanceLandingStep({ _tag: "cardReached", id });
    },
    [advanceLandingStep],
  );

  const latestArrivals = useRef(visit.heldArrivals);
  const latestIsCarrying = useRef(isCarrying);
  useEffect(() => {
    latestArrivals.current = visit.heldArrivals;
    latestIsCarrying.current = isCarrying;
  });
  // The effect below starts again only when the set of waiting cards changes.
  const arrivalKey = visit.heldArrivals.join(" ");
  useEffect(() => {
    if (arrivalKey === "") return;
    const wait = new AbortController();
    void waitForStillHand({
      // The card the pointer rests on is the one that must not move.
      targets: () => [...(scrollRef.current?.querySelectorAll('[data-current="pointer"]') ?? [])],
      isDragging: () => latestIsCarrying.current(),
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
      const arrivedIds = new Set<string>();
      for (const card of born) {
        const { cardId } = card.dataset;
        if (cardId === undefined) continue;
        arrivedIds.add(cardId);
        comeDownIntoPlace(card);
      }
      // The hints under an arriving card are siblings of it, so they come down with it.
      for (const hint of born) {
        if (hint.matches(".inbox-hint") && arrivedIds.has(hint.dataset["leadId"] ?? "")) {
          comeDownIntoPlace(hint);
        }
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
    clearFresh,
  };
};
