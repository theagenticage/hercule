/**
 * The toast after threads are marked done or reopened: "Marked done" or
 * "Reopened" with Undo, or the error of a Done move that failed. It shows over
 * the bottom of the sidebar's list, or, while the sidebar is hidden, at the
 * bottom left of the main pane.
 */
import { useEffect, useEffectEvent, useState, useSyncExternalStore, type JSX } from "react";
import { useDoneMoves } from "../app/done-moves";
import type { DoneToast, DoneToastStore, DoneUndo } from "../app/done-toast-store";
import { Mark } from "../marks";
import { useSidebarLayout } from "./use-sidebar-layout";

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

/**
 * Renders the app's one toast where the user can see it: `place` "sidebar"
 * draws it in the sidebar while the sidebar shows, and `place` "main" draws
 * it at the bottom left of the main pane while the sidebar is hidden. Both
 * places read the same store, so only one of them ever draws a toast, and
 * one that is up when the sidebar is shown or hidden moves to the other.
 * The moved toast starts its five seconds again.
 *
 * Each place reads the sidebar's layout itself, so showing or hiding the
 * sidebar draws these two places and nothing around them.
 */
export function DoneToastHost({
  place,
}: {
  readonly place: "sidebar" | "main";
}): JSX.Element | null {
  const { toasts, undo } = useDoneMoves();
  const { collapsed } = useSidebarLayout();
  if (collapsed !== (place === "main")) return null;
  const toast = <SidebarDoneToast store={toasts} onUndo={undo} />;
  return place === "main" ? <div className="main-toast">{toast}</div> : toast;
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
