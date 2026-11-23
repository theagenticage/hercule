import { useEffect, useId, useRef, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A dialog over a scrim, in the style of the New project dialog: a raised
 * card, 520px wide, named by `title`, drawn as a sentence because it often holds a server's name. Escape and a click on the scrim call
 * `onClose`, and focus starts inside the dialog so Escape reaches it. A
 * control inside that takes focus as the dialog opens, such as a field with
 * `autoFocus`, keeps it.
 *
 * The dialog is drawn on the page body, so no sticky or transformed ancestor
 * (a thread's transcript, the composer) can place it under the page's header.
 * It only draws and reports: the caller owns whether it is open and
 * what closing does.
 */
export function ModalDialog({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.contains(document.activeElement)) dialog.focus();
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex justify-center overflow-y-auto bg-scrim pt-[12vh] pb-8"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
        }}
        className="flex h-fit w-[520px] max-w-[92vw] flex-col gap-3 rounded-card border border-line bg-raised p-3.5 shadow-lift outline-none"
      >
        <h2 id={headingId} className="text-[15px] font-emph tracking-[-0.01em] text-ink">
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
