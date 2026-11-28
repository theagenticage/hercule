import { useId, useLayoutEffect, useRef, type JSX, type ReactNode } from "react";
import { trackBody } from "../../app/motion";
import { CloseIcon } from "../../icons/close";
import "./side-sheet.css";

/** How far in pixels the sheet slides, from the right, as it opens. */
const SLIDE_DISTANCE = 18;

/**
 * Renders the sheet that opens at the right of a page, such as Add to Work,
 * over the page, which stays in view and does not move. `title` heads it, and
 * `onClose` is called by its Close button. `children` fill the rest of the
 * sheet, and own their own spacing and scrolling.
 *
 * It slides in 18px from the right and fades in on the `hand` spring when it
 * mounts, because the click that opened it caused it. Under Reduce motion it
 * only fades. It is not drawn while closed: the caller leaves it out.
 */
export function SideSheet({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  const titleId = useId();
  const sheetRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (sheet === null) return;
    const body = trackBody(sheet);
    body.set({ x: SLIDE_DISTANCE, o: 0 });
    body.to({ x: 0, o: 1 }, "hand");
  }, []);

  return (
    <aside ref={sheetRef} className="side-sheet" aria-labelledby={titleId}>
      <div className="side-sheet-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      {children}
    </aside>
  );
}
