import type { JSX, ReactNode, RefObject } from "react";
import { useShowsClassicScrollbar } from "../session/classic-scrollbar";
import "./fleet-scroll.css";
// The styles of the move between the Fleet page and a machine's page load
// with this component because every Fleet route draws it.
import "./machine-transition.css";

/**
 * Renders the area of a Fleet page that scrolls under the floating header:
 * the Fleet page and a machine's page both draw their content in it.
 *
 * `scrollRef` is the area's element, which the page also gives to
 * `useSectionInView` for its jump links. The area adds `has-scrollbar` while
 * it shows a classic scroll bar, which moves the header's last pill clear of
 * it (see `useShowsClassicScrollbar`). It must stay a sibling that follows
 * the header, because the stylesheet finds it from there.
 */
export function FleetScroll({
  scrollRef,
  children,
}: {
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly children: ReactNode;
}): JSX.Element {
  const showsScrollbar = useShowsClassicScrollbar(scrollRef);
  return (
    <div ref={scrollRef} className={showsScrollbar ? "fleet-scroll has-scrollbar" : "fleet-scroll"}>
      {children}
    </div>
  );
}
