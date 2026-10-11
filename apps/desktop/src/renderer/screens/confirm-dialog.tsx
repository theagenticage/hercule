import { useEffect, useRef, type JSX, type ReactNode, type RefObject } from "react";
import { GlassDialog } from "./glass-dialog";

/**
 * Renders a dialog that asks before something changes or goes: `title`, the
 * explanation in `children`, and the closing button beside the action. A
 * Delete in Settings, the confirmation of a grant change, and Cancel run,
 * Re-run and Delete workspace on a run's page use it.
 *
 * - The action button reads `actionLabel` and is drawn as `actionClass`,
 *   `danger` for something that cannot be undone and `accent` otherwise.
 * - Pressing the action calls `onConfirm`, unless `pending` is true because
 *   an earlier press is still running. The dialog stays open, so the caller
 *   closes it through `dialogRef` once it is done.
 * - Enter in a field of `children`, such as a radio, presses the action too,
 *   as Enter presses the default button of a macOS dialog. Enter on the
 *   closing button presses the closing button.
 * - The closing button reads `closeLabel`, "Cancel" unless the caller says
 *   otherwise.
 * - When the dialog opens, the browser focuses its first control. When
 *   `initialFocus` is given, the dialog focuses that button instead: `close`
 *   for an action that takes something away, so a stray Enter does not press
 *   it, and `action` for one that only adds. A body whose first control is a
 *   checkbox or a radio needs it, so the focus starts on a button.
 * - `error`, when given, is shown under `children` as an alert.
 * - The closing button, Esc and a click on the scrim close the dialog
 *   without calling `onConfirm`. `onClose` is called whenever the dialog
 *   closes, and the caller then unmounts it.
 */
export function ConfirmDialog({
  dialogRef,
  title,
  actionLabel,
  actionClass,
  closeLabel = "Cancel",
  initialFocus,
  pending = false,
  error = null,
  onConfirm,
  onClose,
  children,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly title: string;
  readonly actionLabel: string;
  readonly actionClass: "danger" | "accent";
  readonly closeLabel?: string;
  readonly initialFocus?: "close" | "action" | undefined;
  readonly pending?: boolean;
  readonly error?: string | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  // This effect runs after the one in GlassDialog that opens the dialog,
  // because a child's effects run before its parent's, so the focus set here
  // replaces the focus the browser gave the first control.
  useEffect(() => {
    if (initialFocus === undefined) return;
    (initialFocus === "close" ? closeRef : actionRef).current?.focus();
  }, [initialFocus]);
  return (
    <GlassDialog dialogRef={dialogRef} className="confirm-dialog" label={title} onClose={onClose}>
      <div className="pop-h">
        <b>{title}</b>
      </div>
      {/* A form, so the browser presses the action, its submit button, on
          Enter in a field. */}
      <form
        className="pop-sec confirm-dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending) onConfirm();
        }}
      >
        {children}
        {error !== null && (
          <p className="fl-err" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-dialog-acts">
          <button
            ref={closeRef}
            type="button"
            className="btn btn--quiet"
            onClick={() => dialogRef.current?.close()}
          >
            {closeLabel}
          </button>
          <button
            ref={actionRef}
            type="submit"
            className={`btn btn--${actionClass}`}
            aria-disabled={pending}
          >
            {actionLabel}
          </button>
        </div>
      </form>
    </GlassDialog>
  );
}
