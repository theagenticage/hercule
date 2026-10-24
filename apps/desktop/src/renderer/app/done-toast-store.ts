/**
 * The state behind the toast that follows a Done move ("Marked done" or
 * "Reopened" with Undo, or the error of a move that failed), kept outside
 * React so that the move queue can write it and the sidebar can draw it.
 */

/** A move on the Done state of threads: mark them Done, or reopen them. */
export type DoneMove = "markDone" | "reopen";

/** The move that undoes a Done move, and the threads it applies to: exactly the ones the first move did. */
export interface DoneUndo {
  readonly move: DoneMove;
  readonly sessionIds: readonly string[];
}

/**
 * What the toast shows: the text of a Done move with the `undo`
 * that reverses it, or the error of a move that failed, which has no `undo`.
 * `serial` changes with every toast, so a new toast replaces the last one
 * even when its text is the same.
 */
export interface DoneToast {
  readonly serial: number;
  readonly text: string;
  readonly failed: boolean;
  readonly undo: DoneUndo | null;
}

/**
 * The toast shown, held outside React state so that showing or dismissing a
 * toast redraws only the toast, not the whole sidebar.
 */
export interface DoneToastStore {
  /** Shows a new toast with `undo`, replacing the one shown. Returns the new toast's `serial`. */
  readonly show: (text: string, undo: DoneUndo) => number;
  /**
   * Shows the error `text` of a Done move that failed, as a toast without
   * Undo. `own` is the `serial` of the toast that move showed, or `null` when
   * it showed none.
   *
   * The error replaces the toast shown, except when that toast is the Undo of
   * a different, newer move. Replacing it would take that Undo away. The
   * error is held until that toast goes, then shown. Held errors are shown
   * one after the other.
   */
  readonly showFailure: (text: string, own: number | null) => void;
  /** Hides the toast shown, if any, and shows the next held error. */
  readonly dismiss: () => void;
  /** Calls `listener` after every change; returns the function that stops that. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Returns the toast shown, or `null` for none. */
  readonly read: () => DoneToast | null;
}

/** Creates an empty toast store. `DoneMovesProvider` creates one and keeps it for its life. */
export const createDoneToastStore = (): DoneToastStore => {
  let toast: DoneToast | null = null;
  let serial = 0;
  const heldErrors: string[] = [];
  const listeners = new Set<() => void>();
  const change = (next: DoneToast | null): void => {
    toast = next;
    for (const listener of listeners) listener();
  };
  const display = (text: string, failed: boolean, undo: DoneUndo | null): number => {
    serial += 1;
    change({ serial, text, failed, undo });
    return serial;
  };
  return {
    show: (text, undo) => display(text, false, undo),
    showFailure: (text, own) => {
      if (toast !== null && toast.undo !== null && toast.serial !== own) heldErrors.push(text);
      else display(text, true, null);
    },
    dismiss: () => {
      const next = heldErrors.shift();
      if (next !== undefined) display(next, true, null);
      else if (toast !== null) change(null);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read: () => toast,
  };
};
