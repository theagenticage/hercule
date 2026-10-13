/**
 * The toast over the bottom of the sidebar's list, after a thread is marked
 * done: "Marked done" with Undo, or the error of a Done move that failed.
 */
import { useEffect, useEffectEvent, useState, useSyncExternalStore, type JSX } from "react";
import { Mark } from "../marks";

/** How long the toast shows before it fades, in milliseconds. Intake's toast shows as long. */
const TOAST_SHOWN_MS = 5_000;

/**
 * What the sidebar's toast shows: "Marked done" with Undo, after the thread
 * `sessionId` was marked Done, or the error of a move that failed. `serial`
 * changes with every toast, so a new toast replaces the last one even when
 * its text is the same.
 */
export interface DoneToast {
  readonly serial: number;
  readonly sessionId: string;
  readonly text: string;
  readonly failed: boolean;
}

/**
 * The toast the sidebar shows, held outside React state so that showing or
 * dismissing a toast redraws only the toast, not the whole sidebar.
 */
export interface DoneToastStore {
  /** Shows a new toast, replacing the one shown. */
  readonly show: (sessionId: string, text: string, failed: boolean) => void;
  /** Hides the toast shown, if any. */
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
  const listeners = new Set<() => void>();
  const change = (next: DoneToast | null): void => {
    toast = next;
    for (const listener of listeners) listener();
  };
  return {
    show: (sessionId, text, failed) => {
      serial += 1;
      change({ serial, sessionId, text, failed });
    },
    dismiss: () => {
      if (toast !== null) change(null);
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
 * - "Marked done" leads with the done mark and ends with Undo, which calls
 *   `onUndo` with the thread's session id and dismisses the toast.
 * - A failed move shows its error behind the failed mark, as an alert, with
 *   no Undo.
 */
export function SidebarDoneToast({
  store,
  onUndo,
}: {
  readonly store: DoneToastStore;
  readonly onUndo: (sessionId: string) => void;
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
  readonly onUndo: (sessionId: string) => void;
  readonly onDismiss: () => void;
}): JSX.Element {
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
      {toast.failed ? null : (
        <button
          type="button"
          onClick={() => {
            onUndo(toast.sessionId);
            onDismiss();
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
}
