/**
 * The toast over the bottom of the sidebar's list, after threads are marked
 * done or reopened: "Marked done" or "Reopened" with Undo, or the error of a
 * Done move that failed.
 */
import { useEffect, useEffectEvent, useState, useSyncExternalStore, type JSX } from "react";
import type { DoneToast, DoneToastStore, DoneUndo } from "../app/done-toast-store";
import { Mark } from "../marks";

/** How long the toast shows before it fades, in milliseconds. Intake's toast shows as long. */
const TOAST_SHOWN_MS = 5_000;

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
