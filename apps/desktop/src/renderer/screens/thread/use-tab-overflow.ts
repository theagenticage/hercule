import { useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { pickHiddenTabs } from "./fit-tabs";

/**
 * The widest the work's name text draws in the pill, in pixels, without the
 * slash before it. The name's own style cuts it at the same width; this copy
 * lets the fit count the name at its natural width up to that limit.
 */
const WORK_NAME_TEXT_MAX_WIDTH = 272;

const NO_TABS: ReadonlySet<string> = new Set();

/**
 * Returns the keys of the tabs to hide behind the "+n" button, so that the
 * pill in `navRef` fits in the room `roomRef` gives it. The caller marks
 * each returned tab as overflowed, and shows the "+n" button with the count.
 *
 * The pill's children are found by attribute:
 *
 * - `data-tab="<key>"`: a tab. Tabs must not shrink (`flex: none`), so a
 *   tab has the same width whether or not it is hidden.
 * - `data-tab-overflow`: the "+n" button. It is always rendered. While no
 *   tab is hidden it is out of flow too, and shows the label it would have
 *   for one hidden tab, so there is a width to reserve when one must hide.
 * - `data-work-name`: the work's name, the slash before its text and the
 *   text in a `.work-name-text`. It counts at its natural width, the text
 *   up to 272 px, and the stylesheet shrinks it when pinned tabs need the
 *   room.
 * - A child with a `popover` attribute, such as the "+n" button's menu,
 *   takes no room and is not counted.
 * - Any other child counts at its own width.
 *
 * A hidden tab stays in the DOM, out of flow, with `position: absolute;
 * visibility: hidden`. It is then still measurable, and the hook never has
 * to show every tab to measure them again. The pill must be a positioned
 * element so that these tabs do not escape it. `roomRef` is the element
 * whose width the pill may take (a `flex: 1 1 0; min-width: 0` wrapper). The
 * gap between the pill and the buttons beside it is the caller's: put it
 * outside `roomRef`'s box.
 *
 * Tabs are checked after every render, and again whenever the room or a
 * child of the pill changes size (a font arriving, an age label changing
 * unit, a state word, the open tab turning bold). A single `ResizeObserver`
 * watches them; it never watches the pill itself, whose width follows the
 * fit. Nothing runs while the sizes stay the same.
 *
 * The "+n" button is wider for two digits than for one, and the fit uses the
 * width it has when checked. The fit cannot flip back and forth over this:
 * a wider button hides at least as many tabs as a narrower one, so a button
 * that changed width settles after one more check.
 *
 * `openKey` is the open tab, which never hides. `waitingKeys` are the waiting
 * tabs, which stay visible unless even the open tab and a work name shrunk to
 * nothing leave no room for them (see `pickHiddenTabs`).
 */
export function useTabOverflow(options: {
  readonly roomRef: RefObject<HTMLElement | null>;
  readonly navRef: RefObject<HTMLElement | null>;
  readonly openKey: string | null;
  readonly waitingKeys: readonly string[];
}): ReadonlySet<string> {
  const { roomRef, navRef, openKey, waitingKeys } = options;
  const [hiddenKeys, setHiddenKeys] = useState(NO_TABS);
  const observerRef = useRef<ResizeObserver | null>(null);
  const observedRef = useRef(new Set<Element>());

  // Reads the latest `openKey` and `waitingKeys`, which the observer's callback, made once,
  // could not do by itself.
  const refit = useEffectEvent(() => {
    const room = roomRef.current;
    const nav = navRef.current;
    if (room === null || nav === null) return;
    const next = pickHiddenTabKeys(room, nav, openKey, new Set(waitingKeys));
    setHiddenKeys((current) => (hasSameKeys(current, next) ? current : next));
  });

  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      refit();
    });
    const observed = observedRef.current;
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
      observed.clear();
    };
  }, []);

  // Runs after every render, because a tab can start waiting or become the
  // open tab without any size changing. Also keeps the observer on the room
  // and on the children the pill has now.
  useLayoutEffect(() => {
    const observer = observerRef.current!;
    const observed = observedRef.current;
    const wanted = new Set<Element>(navRef.current?.children ?? []);
    if (roomRef.current !== null) wanted.add(roomRef.current);
    for (const element of observed) {
      if (wanted.has(element)) continue;
      observer.unobserve(element);
      observed.delete(element);
    }
    for (const element of wanted) {
      if (observed.has(element)) continue;
      observer.observe(element);
      observed.add(element);
    }
    refit();
  });

  return hiddenKeys;
}

/** Returns whether `a` and `b` hold the same keys. */
function hasSameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((key) => b.has(key));
}

/**
 * Measures the pill `nav` and returns the keys of the tabs that do not fit in
 * `room`. See `useTabOverflow` for what it reads.
 */
function pickHiddenTabKeys(
  room: HTMLElement,
  nav: HTMLElement,
  openKey: string | null,
  waitingKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const style = getComputedStyle(nav);
  const gap = Number.parseFloat(style.columnGap) || 0;
  // Without a layout, as in jsdom, the computed padding is empty and parses to NaN.
  const padding =
    (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  // Each item below adds its width and one gap; n items have n - 1 gaps.
  let fixedWidth = padding - gap;
  let nameWidth = 0;
  let overflowWidth = 0;
  const tabKeys: string[] = [];
  const tabWidths: number[] = [];
  for (const child of nav.children) {
    // The "+n" button's menu sits in the pill but opens in the top layer, so it takes no room.
    if (!(child instanceof HTMLElement) || child.hasAttribute("popover")) continue;
    const width = child.getBoundingClientRect().width;
    if (child.dataset.tab !== undefined) {
      tabKeys.push(child.dataset.tab);
      tabWidths.push(width + gap);
    } else if (child.dataset.tabOverflow !== undefined) {
      overflowWidth = width + gap;
    } else if (child.dataset.workName !== undefined) {
      const text = child.querySelector<HTMLElement>(".work-name-text");
      // The slash is what comes before the text. Without a layout, as in jsdom, there is neither.
      const slashWidth =
        text === null ? 0 : text.getBoundingClientRect().left - child.getBoundingClientRect().left;
      nameWidth = slashWidth + Math.min(text?.scrollWidth ?? 0, WORK_NAME_TEXT_MAX_WIDTH);
      fixedWidth += gap;
    } else {
      fixedWidth += width + gap;
    }
  }
  // `openKey` can name a tab the pill does not draw (yet), which is no open tab.
  const openTabPosition = openKey === null ? -1 : tabKeys.indexOf(openKey);
  const roomWidth = room.getBoundingClientRect().width;
  const hiddenIndexes = pickHiddenTabs({
    tabWidths,
    openIndex: openTabPosition === -1 ? null : openTabPosition,
    waiting: tabKeys.map((key) => waitingKeys.has(key)),
    fixedWidth,
    nameWidth,
    overflowWidth,
    room: roomWidth,
  });
  limitOpenTab(nav, {
    openIndex: openTabPosition,
    tabWidths,
    hiddenIndexes,
    gap,
    otherWidth: fixedWidth + (hiddenIndexes.size > 0 ? overflowWidth : 0),
    fits: fixedWidth + nameWidth + tabWidths.reduce((sum, width) => sum + width, 0) <= roomWidth,
    room: roomWidth,
  });
  return new Set([...hiddenIndexes].map((index) => tabKeys[index]!));
}

/**
 * Sets `--open-tab-max-width` on `nav`: the width the open tab may take, so
 * that a pill too narrow for the open tab shortens it rather than pushing the
 * "+n" button and the buttons after it out. The open tab never hides, so this
 * is the only way the pill keeps them in view. The stylesheet applies it as
 * the open tab's `max-width`, and its label ellipsizes.
 *
 * The width is what the room leaves after every other part of the pill, with
 * the work's name counted as nothing, since it shrinks first. It is removed
 * while everything fits, so a tab is only ever shortened when it has to be.
 * The open tab's natural width never enters the fit when it is shortened:
 * `pickHiddenTabs` then sees the width set here, which is what it needs to
 * place the other tabs.
 */
function limitOpenTab(
  nav: HTMLElement,
  layout: {
    readonly openIndex: number;
    readonly tabWidths: readonly number[];
    readonly hiddenIndexes: ReadonlySet<number>;
    readonly gap: number;
    /** The width of the pill's parts that are not tabs, the name excepted, with the "+n" button when it shows. */
    readonly otherWidth: number;
    readonly fits: boolean;
    readonly room: number;
  },
): void {
  const { openIndex, tabWidths, hiddenIndexes, gap, otherWidth, fits, room } = layout;
  if (fits || openIndex === -1) {
    nav.style.removeProperty("--open-tab-max-width");
    return;
  }
  const otherTabsWidth = tabWidths
    .filter((_, index) => index !== openIndex && !hiddenIndexes.has(index))
    .reduce((sum, width) => sum + width, 0);
  const width = Math.max(0, room - otherWidth - otherTabsWidth - gap);
  nav.style.setProperty("--open-tab-max-width", `${String(width)}px`);
}
