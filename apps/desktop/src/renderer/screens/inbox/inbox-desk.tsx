import type { JSX, ReactNode, RefObject } from "react";
import { useShowsClassicScrollbar } from "../session/classic-scrollbar";
import "./inbox.css";
import "./inbox-bundle.css";
import "./inbox-states.css";

/** What the desk is showing, which the stylesheet reads from `data-state`. */
export type InboxDeskState = "loading" | "board" | "first-run" | "clear";

/**
 * Renders the frame of the Inbox: the desk, the toolbar that floats over its
 * top and the page under it, which scrolls.
 *
 * - `toolbar` and `overlays` are drawn over the desk, in its own positioning:
 *   the toolbar floats at the top, and sheets and the undo line sit over the
 *   page.
 * - `children` are the page: the wide side and the 320px column, 32px apart
 *   and 32px from the window's edges (the column moves above the work below
 *   1100px), or the one sunrise of an Inbox with nothing at all.
 * - `state` is what the desk shows: the all-clear page is not in columns.
 * - `isHolding` holds the words of the cards back, as while the last visit's
 *   cards wait for a read, and `isArriving` fades the words in, block by
 *   block, once the first read of a visit arrived.
 * - `isOffline` is whether the controller cannot be reached.
 * - `scrollRef` is the element that scrolls, which keys and moves scroll and
 *   measure.
 *
 * The root carries `data-state`. The element that scrolls is `.inbox-scroll`,
 * and the page inside it is `.inbox-page`.
 */
export function InboxDesk({
  toolbar,
  overlays,
  children,
  state,
  isHolding,
  isArriving,
  isOffline,
  scrollRef,
}: {
  readonly toolbar: ReactNode;
  readonly overlays: ReactNode;
  readonly children: ReactNode;
  readonly state: InboxDeskState;
  readonly isHolding: boolean;
  readonly isArriving: boolean;
  readonly isOffline: boolean;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  const hasScrollbar = useShowsClassicScrollbar(scrollRef);
  const classes = [
    "inbox-desk",
    isHolding ? "is-holding" : null,
    isArriving ? "is-arriving" : null,
    isOffline ? "is-offline" : null,
    hasScrollbar ? "has-scrollbar" : null,
  ]
    .filter((each) => each !== null)
    .join(" ");
  return (
    <div className={classes} data-state={state}>
      {toolbar}
      <div ref={scrollRef} className="inbox-scroll" tabIndex={-1}>
        <div className="inbox-page">{children}</div>
      </div>
      {overlays}
    </div>
  );
}
