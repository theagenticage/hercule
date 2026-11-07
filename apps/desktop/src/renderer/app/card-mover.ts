import type { CardPlacement } from "@hercule/client-core/work";

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
}
