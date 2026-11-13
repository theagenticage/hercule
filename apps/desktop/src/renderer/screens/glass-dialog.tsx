/**
 * A modal dialog on Bureau's glass, over a scrim: the project picker, and
 * the provider login and New project dialogs that New thread opens.
 */
import {
  useEffect,
  useRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import "./thread/menus.css";
import "./glass-dialog.css";

/**
 * Renders `children` in a modal dialog that opens as soon as it mounts.
 * `label` is the dialog's accessible name and `className` sets its size and
 * place.
 *
 * Esc, or a click on the scrim, closes the dialog, unless `locked` is set:
 * the caller sets it while something is running that closing would leave
 * half done, and Esc and the scrim then do nothing. `onClose` is called
 * whenever the dialog closes, also when the caller closes it through
 * `dialogRef`; the caller then unmounts it.
 *
 * With `onCloseRequest`, Esc and a click on the scrim call it instead of
 * closing the dialog, and the caller closes the dialog itself, for example
 * after a closing motion. `locked` still wins over it. A caller that hands the focus to
 * something outside the dialog must close the dialog first, because an open
 * modal dialog keeps the focus inside it.
 */
export function GlassDialog({
  dialogRef,
  className,
  label,
  onClose,
  onCloseRequest,
  onKeyDown,
  locked = false,
  children,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly className: string;
  readonly label: string;
  readonly onClose: () => void;
  readonly onCloseRequest?: () => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDialogElement>) => void;
  readonly locked?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  // Whether the last press began on the scrim. A press inside the dialog that
  // is released on the scrim, as when the user selects text, fires its click
  // on the dialog element itself, just as a click on the scrim does.
  const pressedScrimRef = useRef(false);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, [dialogRef]);

  return (
    <dialog
      ref={dialogRef}
      className={`pop glass-dialog ${className}`}
      aria-label={label}
      // The browser closes the dialog itself on Esc, and then fires `close`.
      onClose={onClose}
      // Esc fires `cancel` before the browser closes the dialog; cancelling it keeps the dialog open.
      onCancel={(event) => {
        if (onCloseRequest === undefined) return;
        event.preventDefault();
        if (!locked) onCloseRequest();
      }}
      onKeyDown={(event) => {
        // Cancelling the key press is what stops the browser from closing the dialog on Esc.
        if (locked && event.key === "Escape") event.preventDefault();
        onKeyDown?.(event);
      }}
      // A press on the scrim reaches the dialog itself; a press inside the
      // dialog reaches one of its children, which fill it.
      onPointerDown={(event) => {
        pressedScrimRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (locked || !pressedScrimRef.current || event.target !== event.currentTarget) return;
        if (onCloseRequest !== undefined) onCloseRequest();
        else event.currentTarget.close();
      }}
    >
      {children}
    </dialog>
  );
}
