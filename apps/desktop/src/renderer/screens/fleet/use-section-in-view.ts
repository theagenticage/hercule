import { useEffect, useState, type RefObject } from "react";
import { isMotionReduced } from "../workflows/change-motion";

/**
 * How far the floating header covers the top of the scroll area. A section
 * only counts as in view below it, so a section that was jumped to starts just
 * under the header. It must equal `--fleet-header-clearance` in
 * fleet-scroll.css, which the sections' `scroll-margin-top` reads.
 */
export const FLEET_HEADER_CLEARANCE_PX = 80;

/** The result of `useSectionInView`. */
export interface SectionInView {
  /** The id of the section in view, or null until the first one is. */
  readonly activeSectionId: string | null;
  /** Scrolls the section with `sectionId` to just under the header. */
  readonly scrollToSection: (sectionId: string) => void;
}

/**
 * Tells which of the sections with `sectionIds` is in view in the scroll area
 * `scrollRef`, and offers a way to scroll to one. The sections are the
 * elements inside the area whose `id` is in `sectionIds`, listed from top to
 * bottom.
 *
 * - The section in view is the topmost one with any part showing below the
 *   header. When none shows (a gap between sections), the last one stays.
 * - It uses one IntersectionObserver, so nothing runs while the user is not
 *   scrolling. The observer is disconnected when the page goes.
 * - Scrolling is smooth, and instant while Reduce motion is on.
 */
export function useSectionInView(
  scrollRef: RefObject<HTMLElement | null>,
  sectionIds: ReadonlyArray<string>,
): SectionInView {
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  // The ids as one string, so the effect runs again when the ids change but
  // not when the caller passes a new array holding the same ids.
  const idsKey = sectionIds.join("\n");

  useEffect(() => {
    const scrollArea = scrollRef.current;
    if (scrollArea === null) return;
    const ids = idsKey === "" ? [] : idsKey.split("\n");
    const idOfElement = new Map<Element, string>();
    for (const id of ids) {
      const element = scrollArea.querySelector(`[id="${id}"]`);
      if (element !== null) idOfElement.set(element, id);
    }
    const idsInView = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting } of entries) {
          const id = idOfElement.get(target);
          if (id === undefined) continue;
          if (isIntersecting) idsInView.add(id);
          else idsInView.delete(id);
        }
        const topmost = ids.find((id) => idsInView.has(id));
        if (topmost !== undefined) setActiveSectionId(topmost);
      },
      {
        root: scrollArea,
        rootMargin: `-${String(FLEET_HEADER_CLEARANCE_PX)}px 0px 0px 0px`,
      },
    );
    for (const element of idOfElement.keys()) observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRef, idsKey]);

  const scrollToSection = (sectionId: string): void => {
    scrollRef.current?.querySelector(`[id="${sectionId}"]`)?.scrollIntoView({
      behavior: isMotionReduced() ? "auto" : "smooth",
      block: "start",
    });
  };

  return { activeSectionId, scrollToSection };
}
