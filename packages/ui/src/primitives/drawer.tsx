import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "./button";

/**
 * A panel over the right side of the page that shows detail. It is never a page
 * of its own and never a permanent split view.
 *
 * - Escape and a click on the page behind both close it, so a user who opened
 *   it by accident is never stuck in it.
 * - Focus moves into the panel when it opens and returns to the previously
 *   focused element when it closes, so keyboard users get the same behaviour.
 *   A control inside that takes the focus as the panel opens, such as a
 *   form's first field with `autoFocus`, keeps it.
 * - Escape is handled on the panel, not on the document, so a menu open over
 *   the drawer handles its own Escape and the drawer stays open.
 * - The page behind is not made inert, so the drawer does not claim to be
 *   modal.
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
  // The element that had the focus when the drawer opened. It is read while
  // rendering, before a control inside the drawer can take the focus.
  const [opener, setOpener] = useState(() => (open ? document.activeElement : null));
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpener(document.activeElement);
  }

  useEffect(() => {
    const node = panel.current;
    if (!open || node === null) return;
    if (!node.contains(document.activeElement)) node.focus();
    return () => {
      // The focus goes back only once the panel has left the page. React's
      // development mode runs every effect's cleanup once while the panel
      // stays; moving the focus then would take it from a control inside.
      queueMicrotask(() => {
        if (!node.isConnected && opener instanceof HTMLElement) opener.focus();
      });
    };
  }, [open, opener]);

  // The page keeps room for its scrollbar (see `scrollbar-gutter` in the
  // stylesheet), and a fixed backdrop cannot cover that room. While the
  // drawer is open, the stylesheet dims the page's own background, which is
  // what shows in the room, to match the backdrop.
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.toggleAttribute("data-drawer-open", true);
    return () => {
      root.removeAttribute("data-drawer-open");
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
