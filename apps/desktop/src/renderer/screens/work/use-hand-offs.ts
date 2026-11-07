import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { WorkCard } from "@hercule/contract";
import { playHandOff } from "./board-flights";

/** How long a hand-off waits for its trigger, in milliseconds. After this it is forgotten. */
const HAND_OFF_PATIENCE_MS = 30_000;

/**
 * What a hand-off waits for before it plays:
 *
 * - `colleague-arrives`: the card gets a colleague. A Thread was started on a
 *   Task that had none, and the colleague comes with the board read that follows.
 * - `failure-clears`: the board stops showing the card's failure. A failed run
 *   was started again, and the card already has a colleague (the plaster) that
 *   turns into the working one.
 */
export type HandOffTrigger = "colleague-arrives" | "failure-clears";

/** What `useHandOffs` returns. */
export interface HandOffs {
  /**
   * Says that a hand-off is due on the card of the Task `taskId` once `trigger`
   * happens. With `colleague-arrives`, a card that has a colleague already is
   * not waited for, since it has no new head to bring up. With `failure-clears`,
   * a card that shows no failure already plays at once.
   */
  readonly noteHandOff: (taskId: string, trigger: HandOffTrigger) => void;
  /** Forgets the hand-off of the Task `taskId`. Returns whether one was still waiting, so it never played. */
  readonly forgetHandOff: (taskId: string) => boolean;
}

/** What one waiting hand-off needs to know. */
interface WaitingHandOff {
  readonly trigger: HandOffTrigger;
  /** The time it was noted, from `performance.now()`. */
  readonly since: number;
}

/**
 * Plays a hand-off on a card when its trigger has happened: the colleague's
 * head rises from behind the card's top edge (`playHandOff`). The trigger
 * comes with a board read that follows the user's action, so the hand-off
 * waits for it instead of guessing when. `cards` are the cards the board draws.
 *
 * The hand-off is looked for after every render of the caller, so the caller
 * must render when the board changes. A hand-off whose card leaves the board
 * (for `failure-clears`) or that waits longer than 30 seconds is forgotten.
 */
export const useHandOffs = (
  scrollRef: RefObject<HTMLElement | null>,
  cards: readonly WorkCard[],
): HandOffs => {
  const waiting = useRef(new Map<string, WaitingHandOff>());
  const shownCards = useRef(cards);

  const findCardElement = useCallback(
    (taskId: string): HTMLElement | null =>
      scrollRef.current?.querySelector<HTMLElement>(`[data-card-id="${taskId}"]`) ?? null,
    [scrollRef],
  );

  /** Plays every waiting hand-off whose trigger has happened, and forgets the ones that can no longer play. */
  const playReadyHandOffs = useCallback((): void => {
    for (const [taskId, wait] of waiting.current) {
      const element = findCardElement(taskId);
      const card = shownCards.current.find((each) => each.id === taskId);
      const isReady =
        wait.trigger === "colleague-arrives"
          ? element?.querySelector(".card-head") != null
          : card !== undefined && card.failure === undefined;
      if (isReady) {
        waiting.current.delete(taskId);
        if (element !== null) playHandOff(element);
      } else if (
        (wait.trigger === "failure-clears" && card === undefined) ||
        performance.now() - wait.since > HAND_OFF_PATIENCE_MS
      ) {
        waiting.current.delete(taskId);
      }
    }
  }, [findCardElement]);

  const noteHandOff = useCallback(
    (taskId: string, trigger: HandOffTrigger): void => {
      if (trigger === "colleague-arrives" && findCardElement(taskId)?.querySelector(".card-head")) {
        return;
      }
      waiting.current.set(taskId, { trigger, since: performance.now() });
      playReadyHandOffs();
    },
    [findCardElement, playReadyHandOffs],
  );

  const forgetHandOff = useCallback(
    (taskId: string): boolean => waiting.current.delete(taskId),
    [],
  );

  useLayoutEffect(() => {
    shownCards.current = cards;
    if (waiting.current.size > 0) playReadyHandOffs();
  });

  return { noteHandOff, forgetHandOff };
};
