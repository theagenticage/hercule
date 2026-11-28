/**
 * The card moves the Work board has made and the controller has not answered
 * yet, kept outside the Work screen. A screen that is left and opened again
 * must still draw a card as Done while its update is on the way. Otherwise the
 * card comes back on the board, and Undo has nothing to put back: it would
 * see the card on the board and send no inverse, so the Done lands anyway.
 *
 * The store belongs to one controller and one user. The router clears it when
 * the user signs out (see `createAppRouter`). Nothing is saved.
 */
import type { CardChange } from "@hercule/client-core/work";

/** A move the controller has not answered yet: waiting to be sent, or sent. */
export interface PendingMove {
  readonly change: CardChange;
  /**
   * Set on the move that undoes another. The move is sent only when this
   * resolves to true, which it does when the move being undone was saved.
   * Otherwise the card is still where the undo would put it, or another client
   * has moved it since, and writing the undo would overwrite that.
   */
  readonly isUndoWanted: Promise<boolean> | undefined;
}

/**
 * Returns whether any of `moves` (a move, an end, or an Undo) is for the Task
 * `taskId`. A second change to a Task whose first change is still on its way
 * would take its Undo from a board that may not stay true: the first may be
 * refused.
 */
export const hasPendingMove = (moves: readonly PendingMove[], taskId: string): boolean =>
  moves.some(({ change }) =>
    change.kind === "move" ? change.move.taskId === taskId : change.card.id === taskId,
  );

export interface PendingCardMoves {
  /**
   * Returns the pending moves, oldest first. The same array comes back until
   * the next change, as React's `useSyncExternalStore` requires.
   */
  readonly getSnapshot: () => readonly PendingMove[];
  /** Calls `listener` after every change, until the returned function is called. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Adds `move` as the newest. */
  readonly add: (move: PendingMove) => void;
  /** Removes `move`, once the controller has answered it. Does nothing when it is not there. */
  readonly remove: (move: PendingMove) => void;
  /** Forgets every move. A request that is already on its way is not stopped. */
  readonly clear: () => void;
}

/** Creates a store with no pending moves. */
export const createPendingCardMoves = (): PendingCardMoves => {
  let moves: readonly PendingMove[] = [];
  const listeners = new Set<() => void>();
  const change = (next: readonly PendingMove[]): void => {
    moves = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => moves,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    add: (move) => {
      change([...moves, move]);
    },
    remove: (move) => {
      if (moves.includes(move)) change(moves.filter((each) => each !== move));
    },
    clear: () => {
      if (moves.length > 0) change([]);
    },
  };
};
