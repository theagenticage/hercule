import type { CardPlacement, EndStage } from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";

/** A card being put back: whether it went exactly where it was, and the request that moves it. */
export interface PutBackRequest {
  readonly isExact: boolean;
  readonly request: Promise<unknown>;
}

/**
 * What the Work screen that is open lends to a gesture on the undo stack, so
 * that Undo moves the card through that screen's own list of pending moves.
 * A gesture outlives the screen that made it: leaving Work and coming back
 * opens a new screen with a new list.
 */
export interface CardMover {
  /**
   * Shows the card back at `place`, as Undo does, and queues the move. The
   * move is sent only if `isUndoWanted` resolves to true, which it does when
   * the gesture being undone was saved: a gesture that was refused changed
   * nothing, and the card may since have been moved by another client.
   * Returns `undefined` when the card is no longer on the board.
   */
  readonly putCardBack: (
    place: CardPlacement,
    isUndoWanted: Promise<boolean>,
  ) => PutBackRequest | undefined;
  /**
   * Shows `card`, a card that ended at `stage` (Done or Dropped), back at
   * `place`, and queues the move that takes the Task out of its end. The move
   * is sent only if `isUndoWanted` resolves to true. Returns `undefined` when
   * the card is on the board already.
   */
  readonly putEndedCardBack: (
    card: WorkCard,
    place: CardPlacement,
    stage: EndStage,
    isUndoWanted: Promise<boolean>,
  ) => PutBackRequest | undefined;
}
