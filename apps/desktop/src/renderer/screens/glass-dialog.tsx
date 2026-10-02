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
 * Esc, or a click on the scrim, closes the dialog. `onClose` is called
 * whenever the dialog closes, also when the caller closes it through
 * `dialogRef`; the caller then unmounts it. A caller that hands the focus to
 * something outside the dialog must close the dialog first, because an open
 * modal dialog keeps the focus inside it.
 */
export function GlassDialog({
  dialogRef,
  className,
  label,
  onClose,
  onKeyDown,
  children,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly className: string;
  readonly label: string;
  readonly onClose: () => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDialogElement>) => void;
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
      onKeyDown={onKeyDown}
      // A press on the scrim reaches the dialog itself; a press inside the
      // dialog reaches one of its children, which fill it.
      onPointerDown={(event) => {
        pressedScrimRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (pressedScrimRef.current && event.target === event.currentTarget)
          event.currentTarget.close();
      }}
    >
      {children}
    </dialog>
  );
}
