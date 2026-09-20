import { useEffect, useRef, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "./button";

/**
 * Detail over the page, on the right, never a page of its own and never a
 * permanent split.
 *
 * Escape and the page behind it both close it, so a reader who opened one by
 * accident is never trapped in it. Focus moves into the panel when it opens and
 * back to whatever had it when it closes, which is what makes the same two
 * gestures work for someone driving from the keyboard. Escape is heard on the
 * panel rather than on the document, so a menu opened over the drawer takes its
 * own Escape and the drawer stays where it is.
 *
 * The page behind stays reachable: nothing here makes it inert, so the drawer
 * does not claim to be modal.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element | null {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement;
    panel.current?.focus();
    return () => {
      if (returnTo instanceof HTMLElement) returnTo.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40">
      <div
        data-backdrop
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-scrim"
      />
      <div
        ref={panel}
        role="dialog"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === "Escape") onClose();
        }}
        className="hercule-drawer absolute top-0 right-0 flex h-full w-[440px] max-w-[92vw] flex-col border-l border-line bg-raised shadow-lift outline-none"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-lead font-emph text-balance text-ink">{title}</h2>
          <Button aria-label="Close" onClick={onClose} className="-mt-0.5 shrink-0 px-1.5">
            <svg viewBox="0 0 12 12" width={12} height={12} fill="none" aria-hidden="true">
              <path
                d="m3 3 6 6M9 3l-6 6"
                stroke="currentColor"
                strokeWidth={1.15}
                strokeLinecap="round"
              />
            </svg>
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
