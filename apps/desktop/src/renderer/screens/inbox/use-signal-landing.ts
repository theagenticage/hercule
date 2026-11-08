import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { LandingStep, SignalLanding } from "@hercule/client-core/inbox";
import {
  findLandingElement,
  holdSentence,
  isShownOnPage,
  lightRim,
  playReaction,
  REACTION_DELAY_MS,
  planDrop,
  startDrops,
  type LandingTone,
} from "./landing";

/**
 * Plays the landing of a signal that the visit asks for (`InboxVisit.landing`)
 * on the Inbox page, and reports back when its drop has landed. The visit
 * decides everything else: which cards a signal landed on, which keep their old
 * words until then, and which are fresh. This hook only measures the page and
 * plays.
 *
 * - The cause shows first. For each landed card on the page, a drop falls onto
 *   its line while the card still shows its old words. `REACTION_DELAY_MS`
 *   later, the hook reports `dropLanded`, the visit draws the new words, and
 *   in the same frame the knock, the roll and the rim play (`playReaction`).
 *   Nothing changes place: only the card's own words are held back.
 * - A landed card that is not on screen, or is not drawn, plays nothing and
 *   waits the same time, which no one sees.
 * - Under Reduce motion nothing is held: the words are drawn already, and the
 *   rim fades. There is no drop to report.
 *
 * `scrollRef` is the element that scrolls the page, and `advanceLanding`
 * applies a step to the visit and returns the ids of the cards it released.
 * It must be stable. One timer runs for each landing, and they stop when the
 * screen closes.
 */
export const useSignalLanding = ({
  landing,
  scrollRef,
  advanceLanding,
}: {
  readonly landing: SignalLanding | undefined;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly advanceLanding: (step: LandingStep) => readonly string[];
}): void => {
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const timer of running) clearTimeout(timer);
      running.clear();
    };
  }, []);

  // A landing starts once the page shows what the visit holds: the cards with the words they had.
  useLayoutEffect(() => {
    if (landing === undefined) return;
    const scroller = scrollRef.current;
    // Everything is measured before anything is written, so a landing on many cards costs one layout.
    const shown =
      scroller === null
        ? []
        : landing.cards.flatMap(({ id, tone }) => {
            const element = findLandingElement(scroller, id);
            return element === null || !isShownOnPage(scroller, element)
              ? []
              : [{ id, element, tone }];
          });
    if (landing.isReduced) {
      for (const { element, tone } of shown) lightRim(element, tone, true);
      return;
    }
    const planned = shown.flatMap(({ id, element, tone }) => {
      const plan = planDrop(element, tone);
      return plan === undefined ? [] : [{ id, plan }];
    });
    const dropped = new Map<string, LandingTone>(planned.map(({ id, plan }) => [id, plan.tone]));
    if (scroller !== null)
      startDrops(
        scroller,
        planned.map(({ plan }) => plan),
      );

    /** Reports that the drop has landed, and plays the reaction on the released cards a drop fell on. */
    const letLand = (): void => {
      // The old words are still on the page: keep a copy of each sentence, to roll it away.
      const reactions = [...dropped].flatMap(([id, tone]) => {
        const element = scroller === null ? null : findLandingElement(scroller, id);
        return element === null ? [] : [{ id, element, tone, was: holdSentence(element) }];
      });
      const released = flushSync(() =>
        advanceLanding({ _tag: "dropLanded", landing: landing.number }),
      );
      for (const { id, element, tone, was } of reactions) {
        if (released.includes(id)) playReaction(element, tone, was);
      }
    };
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      letLand();
    }, REACTION_DELAY_MS);
    timers.current.add(timer);
  }, [landing, scrollRef, advanceLanding]);
};
