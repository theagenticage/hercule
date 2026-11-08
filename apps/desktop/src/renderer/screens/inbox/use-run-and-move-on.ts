import type { RefObject } from "react";
import { decideCardRisingIntoPlace, decideNextWaitingCard } from "@hercule/client-core/inbox";
import { readInboxStops } from "./inbox-page-dom";
import type { CurrentBy, CurrentCard } from "./use-current-card";
import type { OpenCard } from "./use-open-card";

/** The sheet that opens a card, as the page moves on over it. */
export type OpenCardControls = Pick<
  OpenCard,
  "isOpen" | "origin" | "shown" | "open" | "close" | "walk"
>;

/** Runs `run`, a move on the card `cardId`, then moves the page on to the next card. `by` is how the user asked. */
export type RunAndMoveOn = (cardId: string, by: CurrentBy, run: () => void) => void;

/**
 * Returns the function that runs a move on a card and then moves the page on:
 * the current card goes to the next that waits, or the open sheet walks to it.
 * The next card is chosen before the move, because a dismissal takes the card
 * off the page. The pointer only goes to the card that rises into the card's
 * place; the keys go back when nothing follows. `scrollRef` is the element
 * that scrolls the page, `current` the current card, and `open` the sheet.
 */
export const useRunAndMoveOn =
  ({
    scrollRef,
    current,
    open,
  }: {
    readonly scrollRef: RefObject<HTMLElement | null>;
    readonly current: CurrentCard;
    readonly open: OpenCardControls;
  }): RunAndMoveOn =>
  (cardId, by, run) => {
    const scroller = scrollRef.current;
    const decideNext = by === "pointer" ? decideCardRisingIntoPlace : decideNextWaitingCard;
    const next = scroller === null ? undefined : decideNext(readInboxStops(scroller), cardId);
    run();
    if (!open.isOpen) {
      // The keys make the next card current, or none; the pointer hands it over.
      if (by === "keys") current.set(next ?? null, "keys");
      else current.handOver(next ?? null);
    } else if (next === undefined) open.close();
    else {
      open.walk(next);
      current.set(next, "keys", false);
    }
  };
