import type { JSX, ReactNode, RefObject } from "react";
import { GlassDialog } from "./glass-dialog";

/**
 * Renders a dialog that asks before something changes or goes: `title`, the
 * explanation in `children`, and Cancel beside the action. A Delete in
 * Settings and the confirmation of a grant change use it.
 *
 * - The action button reads `actionLabel` and is drawn as `actionClass`,
 *   `danger` for something that cannot be undone and `accent` otherwise.
 * - Pressing the action calls `onConfirm`, unless `pending` is true because
 *   an earlier press is still running. The dialog stays open, so the caller
 *   closes it through `dialogRef` once it is done.
 * - Enter in a field of `children`, such as a radio, presses the action too,
 *   as Enter presses the default button of a macOS dialog. Enter on Cancel
 *   presses Cancel.
 * - `error`, when given, is shown under `children` as an alert.
 * - Cancel, Esc and a click on the scrim close the dialog without calling
 *   `onConfirm`. `onClose` is called whenever the dialog closes, and the
 *   caller then unmounts it.
 */
export function ConfirmDialog({
  dialogRef,
  title,
  actionLabel,
  actionClass,
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
  readonly pending?: boolean;
  readonly error?: string | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): JSX.Element {
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
            type="button"
            className="btn btn--quiet"
            onClick={() => dialogRef.current?.close()}
          >
            Cancel
          </button>
          <button type="submit" className={`btn btn--${actionClass}`} aria-disabled={pending}>
            {actionLabel}
          </button>
        </div>
      </form>
    </GlassDialog>
  );
}
