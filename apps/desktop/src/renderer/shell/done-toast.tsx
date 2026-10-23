/**
 * The toast over the bottom of the sidebar's list, after threads are marked
 * done or reopened: "Marked done" or "Reopened" with Undo, or the error of a
 * Done move that failed.
 */
import { useEffect, useEffectEvent, useState, useSyncExternalStore, type JSX } from "react";
import { Mark } from "../marks";

/** How long the toast shows before it fades, in milliseconds. Intake's toast shows as long. */
const TOAST_SHOWN_MS = 5_000;

/** A move on the Done state of threads: mark them Done, or reopen them. */
export type DoneMove = "markDone" | "reopen";

/** The move that undoes a Done move, and the threads it applies to: exactly the ones the first move did. */
export interface DoneUndo {
  readonly move: DoneMove;
  readonly sessionIds: readonly string[];
}

/**
 * What the sidebar's toast shows: the text of a Done move with the `undo`
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
 * The toast the sidebar shows, held outside React state so that showing or
 * dismissing a toast redraws only the toast, not the whole sidebar.
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

/** Creates an empty toast store. The sidebar creates one and keeps it for its life. */
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

/**
 * Renders the toast `store` holds, or nothing when it holds none.
 *
 * - The toast shows for five seconds, then fades and is dismissed.
 *   While the pointer is on it, it stays; when the pointer leaves, the five
 *   seconds start again. Under Reduce motion it neither rises nor fades: it
 *   goes at once.
 * - A Done move's toast leads with the done mark and ends with Undo, which
 *   calls `onUndo` with the toast's `undo` and dismisses the toast.
 * - A failed move shows its error behind the failed mark, as an alert, with
 *   no Undo.
 */
export function SidebarDoneToast({
  store,
  onUndo,
}: {
  readonly store: DoneToastStore;
  readonly onUndo: (undo: DoneUndo) => void;
}): JSX.Element {
  const toast = useSyncExternalStore(store.subscribe, store.read);
  // The anchor stays when there is no toast, so the list above never moves.
  return (
    <div className="side-toast-anchor">
      {toast !== null && (
        <ToastLine key={toast.serial} toast={toast} onUndo={onUndo} onDismiss={store.dismiss} />
      )}
    </div>
  );
}

/** Renders one toast, as `SidebarDoneToast` describes. */
function ToastLine({
  toast,
  onUndo,
  onDismiss,
}: {
  readonly toast: DoneToast;
  readonly onUndo: (undo: DoneUndo) => void;
  readonly onDismiss: () => void;
}): JSX.Element {
  const { undo } = toast;
  const [held, setHeld] = useState(false);
  const [fading, setFading] = useState(false);
  const dismiss = useEffectEvent(onDismiss);
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(() => {
      // Under Reduce motion no fade runs, so no animation would end to dismiss it.
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) dismiss();
      else setFading(true);
    }, TOAST_SHOWN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [held]);

  return (
    <div
      className={`side-toast ${fading ? "is-fading" : "is-new"}`}
      role={toast.failed ? "alert" : "status"}
      onPointerEnter={() => {
        setHeld(true);
        setFading(false);
      }}
      onPointerLeave={() => {
        setHeld(false);
      }}
      onAnimationEnd={(event) => {
        if (event.animationName === "side-toast-fade") onDismiss();
      }}
    >
      <Mark state={toast.failed ? "failed" : "done"} />
      <span className="side-toast-text">{toast.text}</span>
      {undo === null ? null : (
        <button
          type="button"
          onClick={() => {
            onUndo(undo);
            onDismiss();
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
}
