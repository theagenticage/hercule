import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { playHandOff } from "./board-flights";

/** How long a hand-off waits for the colleague to appear on the card, in milliseconds. After this it is forgotten. */
const HAND_OFF_PATIENCE_MS = 30_000;

/**
 * Plays a hand-off on a card when the colleague of a Thread the user just
 * started shows up on it: its head rises from behind the card's top edge
 * (`playHandOff`). The head comes with the board read that follows the
 * start, so the hand-off waits for it instead of guessing when.
 *
 * `noteHandOff(taskId)` says a Thread was started on that Task. It remembers
 * the Task only when its card has no colleague yet, since a card that has
 * one already has no head to bring up. The hand-off is looked for after every
 * render of the caller, so the caller must render when the board changes.
 */
export const useHandOffs = (
  scrollRef: RefObject<HTMLElement | null>,
): { readonly noteHandOff: (taskId: string) => void } => {
  const waiting = useRef(new Map<string, number>());

  const noteHandOff = useCallback(
    (taskId: string): void => {
      const card = scrollRef.current?.querySelector(`[data-card-id="${taskId}"]`);
      if (card?.querySelector(".card-head") != null) return;
      waiting.current.set(taskId, performance.now());
    },
    [scrollRef],
  );

  useLayoutEffect(() => {
    if (waiting.current.size === 0) return;
    for (const [taskId, since] of waiting.current) {
      const card = scrollRef.current?.querySelector<HTMLElement>(`[data-card-id="${taskId}"]`);
      if (card?.querySelector(".card-head") != null) {
        waiting.current.delete(taskId);
        playHandOff(card);
      } else if (performance.now() - since > HAND_OFF_PATIENCE_MS) {
        waiting.current.delete(taskId);
      }
    }
  });

  return { noteHandOff };
};
