import { useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { fitPill, type PillFit } from "./fit-tabs";

const NO_TABS: ReadonlySet<string> = new Set();

/**
 * Returns the keys of the tabs to hide behind the "+n" button, so that the
 * pill in `navRef` fits in the room `roomRef` gives it. The caller marks
 * each returned tab as overflowed, and shows the "+n" button with the count.
 * The hook also limits the widths of the open tab and of the crumbs' names
 * when the room is too short even without the other tabs (see `fitPill`).
 *
 * The pill's children are found by attribute and class:
 *
 * - `data-tab="<key>"`: a tab. Tabs must not shrink (`flex: none`), so a
 *   tab has the same width whether or not it is hidden. In the open tab, the
 *   `.ptab-title` is the label that gets shortened. A tab with no
 *   `.ptab-title` is never shortened.
 * - `data-tab-overflow`: the "+n" button. It is always rendered. While no
 *   tab is hidden it is out of flow too, and shows the label it would have
 *   for one hidden tab, so there is a width to reserve when one must hide.
 * - `data-work-name`: the work's name, the slash before its text and the
 *   text in a `.work-name-text`. It counts at its natural width, the text
 *   up to the text's own `max-width`, and the stylesheet shrinks it when the
 *   tabs need the room.
 * - `.pill-crumb`: a crumb. It must not shrink (`flex: none`). Its name is
 *   the `.proj-name` of a project's crumb, or else the first `a` or `span`
 *   in it, and this hook limits that element's `max-width`. A crumb with
 *   neither counts at its own width. The rest of the crumb (its padding, its
 *   tile) is never shortened. Crumbs are drawn by other components, and a
 *   name can mount later (a run's crumbs load lazily), so a
 *   `MutationObserver` watches the pill's children.
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
 * Only natural widths are measured, never one that a limit of this hook
 * shortened: the open tab's label and each crumb's name are measured by
 * their `scrollWidth`, the width of their text. Because of that, the limits
 * that the check writes do not change what the next check reads, and the
 * pill settles after one check.
 *
 * A check runs after every render of the caller, because a tab can start
 * waiting or become the open tab without any size changing. It also runs
 * when the room or a child of the pill changes size (a font arriving, an
 * age label changing unit, a state word, the open tab turning bold), and
 * when a child is added or removed. A single `ResizeObserver` watches the
 * room and the children; it never watches the pill itself, whose width
 * follows the fit. A check that finds nothing to change writes nothing:
 * not to the DOM and not to state.
 *
 * The "+n" button is wider for two digits than for one, and the fit uses the
 * width it has when checked. The fit cannot flip back and forth over this:
 * a wider button hides at least as many tabs as a narrower one, so a button
 * that changed width settles after one more check.
 *
 * `openKey` is the open tab, which never hides. `waitingKeys` are the waiting
 * tabs, which stay visible unless even the open tab leaves no room for them
 * after the work's name and the crumbs' names shrunk to nothing (see
 * `pickHiddenTabs`).
 */
export function useTabOverflow(options: {
  readonly roomRef: RefObject<HTMLElement | null>;
  readonly navRef: RefObject<HTMLElement | null>;
  readonly openKey: string | null;
  readonly waitingKeys: readonly string[];
}): ReadonlySet<string> {
  const { roomRef, navRef, openKey, waitingKeys } = options;
  const [hiddenKeys, setHiddenKeys] = useState(NO_TABS);
  const pillStyleRef = useRef<PillStyle | null>(null);

  // Reads the latest props and state, which the observers' callbacks, made
  // once, could not do by themselves.
  const refit = useEffectEvent(() => {
    const room = roomRef.current;
    const nav = navRef.current;
    if (room === null || nav === null) return;
    const measurement = measurePill(room, nav, openKey, new Set(waitingKeys), pillStyleRef);
    applyLimits(nav, measurement.crumbTexts, measurement.fit);
    const next = new Set(
      [...measurement.fit.hiddenIndexes].map((index) => measurement.tabKeys[index]!),
    );
    if (!hasSameKeys(hiddenKeys, next)) setHiddenKeys(next);
  });

  useLayoutEffect(() => {
    const observed = new Set<Element>();
    const resizes = new ResizeObserver(() => {
      refit();
    });
    // Keeps the resize observer on the room and on the children the pill has now.
    const watch = (): void => {
      const wanted = new Set<Element>(navRef.current?.children ?? []);
      if (roomRef.current !== null) wanted.add(roomRef.current);
      for (const element of observed) {
        if (wanted.has(element)) continue;
        resizes.unobserve(element);
        observed.delete(element);
      }
      for (const element of wanted) {
        if (observed.has(element)) continue;
        resizes.observe(element);
        observed.add(element);
      }
    };
    // Watches and fits the children that come and go, including those that
    // mount without the caller rendering, such as a run's crumbs after they load.
    const mutations = new MutationObserver(() => {
      watch();
      refit();
    });
    if (navRef.current !== null) mutations.observe(navRef.current, { childList: true });
    watch();
    return () => {
      resizes.disconnect();
      mutations.disconnect();
      observed.clear();
    };
  }, [navRef, roomRef]);

  // Runs after every render. The children a render adds or removes are
  // picked up by the mutation observer above.
  useLayoutEffect(() => {
    refit();
  });

  return hiddenKeys;
}

/** Returns whether `a` and `b` hold the same keys. */
function hasSameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((key) => b.has(key));
}

/**
 * The pill's gap and horizontal padding. They do not change while the pill is
 * on screen, so a check reads them once: reading a computed style is the most
 * costly thing a check does. A `max-width` is not kept the same way, because
 * a class can change it while the element stays (a tab's label loses
 * `is-title`, and its 160px limit, when the session gets a role).
 */
interface PillStyle {
  readonly gap: number;
  readonly padding: number;
}

/** Returns the `max-width` the stylesheet gives `element` now, or `Infinity` when it gives none. */
function readMaxWidth(element: Element): number {
  // Without a layout, as in jsdom, the computed value is empty and parses to NaN.
  const parsed = Number.parseFloat(getComputedStyle(element).maxWidth);
  return Number.isNaN(parsed) ? Infinity : parsed;
}

/**
 * Returns the width the text of `element` would take with no limit on it:
 * its `scrollWidth`, up to the `max-width` its stylesheet gives it. The
 * `scrollWidth` of a box whose text is cut is the text's full width, so the
 * result does not depend on any limit this hook set.
 */
function readNaturalTextWidth(element: HTMLElement): number {
  return Math.min(element.scrollWidth, readMaxWidth(element));
}

/**
 * Returns the element holding the name of `crumb`, the part a narrow pill
 * may shorten, or `null` when the crumb has none.
 */
function findCrumbText(crumb: HTMLElement): HTMLElement | null {
  return (
    crumb.querySelector<HTMLElement>(".proj-name") ??
    crumb.querySelector<HTMLElement>(":scope > a, :scope > span")
  );
}

/**
 * Measures the pill `nav` in `room` and decides how it fits. Returns the fit,
 * the keys of the tabs in the order the fit counts them, and the elements of
 * the crumbs' names in the order of the fit's `crumbTextMaxWidths`. It only
 * reads the DOM. See `useTabOverflow` for what it reads.
 */
function measurePill(
  room: HTMLElement,
  nav: HTMLElement,
  openKey: string | null,
  waitingKeys: ReadonlySet<string>,
  pillStyleRef: { current: PillStyle | null },
): {
  readonly fit: PillFit;
  readonly tabKeys: readonly string[];
  readonly crumbTexts: readonly HTMLElement[];
} {
  if (pillStyleRef.current === null) {
    const style = getComputedStyle(nav);
    pillStyleRef.current = {
      gap: Number.parseFloat(style.columnGap) || 0,
      // Without a layout, as in jsdom, the computed padding is empty and parses to NaN.
      padding:
        (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0),
    };
  }
  const { gap, padding } = pillStyleRef.current;
  // Each item below adds its width and one gap; n items have n - 1 gaps.
  let fixedWidth = padding - gap;
  let nameWidth = 0;
  let overflowWidth = 0;
  const tabKeys: string[] = [];
  const tabWidths: number[] = [];
  const crumbTexts: HTMLElement[] = [];
  const crumbTextWidths: number[] = [];
  let openTabMinWidth = 0;
  for (const child of nav.children) {
    // The "+n" button's menu sits in the pill but opens in the top layer, so it takes no room.
    if (!(child instanceof HTMLElement) || child.hasAttribute("popover")) continue;
    const width = child.getBoundingClientRect().width;
    if (child.dataset.tab !== undefined) {
      tabKeys.push(child.dataset.tab);
      const isOpen = child.dataset.tab === openKey;
      const tab = measureTab(child, isOpen);
      tabWidths.push(tab.width + gap);
      if (isOpen) openTabMinWidth = tab.minWidth;
    } else if (child.dataset.tabOverflow !== undefined) {
      overflowWidth = width + gap;
    } else if (child.dataset.workName !== undefined) {
      const text = child.querySelector<HTMLElement>(".work-name-text");
      // The slash is what comes before the text. Without a layout, as in jsdom, there is neither.
      const slashWidth =
        text === null ? 0 : text.getBoundingClientRect().left - child.getBoundingClientRect().left;
      nameWidth = slashWidth + (text === null ? 0 : readNaturalTextWidth(text));
      fixedWidth += gap;
    } else {
      const text = child.classList.contains("pill-crumb") ? findCrumbText(child) : null;
      if (text === null) {
        fixedWidth += width + gap;
        continue;
      }
      // The crumb's own `max-width` cuts its name too, whatever the name's width.
      const otherWidth = width - text.getBoundingClientRect().width;
      crumbTexts.push(text);
      crumbTextWidths.push(
        Math.max(0, Math.min(text.scrollWidth, readMaxWidth(child) - otherWidth)),
      );
      fixedWidth += otherWidth + gap;
    }
  }
  // `openKey` can name a tab the pill does not draw (yet), which is no open tab.
  const openIndex = openKey === null ? -1 : tabKeys.indexOf(openKey);
  const fit = fitPill({
    tabWidths,
    openIndex: openIndex === -1 ? null : openIndex,
    waiting: tabKeys.map((key) => waitingKeys.has(key)),
    fixedWidth,
    nameWidth,
    overflowWidth,
    room: room.getBoundingClientRect().width,
    crumbTextWidths,
    gap,
    openTabMinWidth,
  });
  return { fit, tabKeys, crumbTexts };
}

/**
 * Returns the width of `tab` with no limit on it, and the narrowest it can be
 * drawn. Only the open tab is ever limited. If it has a `.ptab-title`, that
 * label can shorten to nothing, so its narrowest width is the rest of the
 * tab, as measured, and its natural width has the label at its natural
 * width. Another tab is as measured, and cannot be shortened.
 */
function measureTab(
  tab: HTMLElement,
  isOpen: boolean,
): { readonly width: number; readonly minWidth: number } {
  const width = tab.getBoundingClientRect().width;
  const label = isOpen ? tab.querySelector<HTMLElement>(".ptab-title") : null;
  if (label === null) return { width, minWidth: width };
  const minWidth = width - label.getBoundingClientRect().width;
  return { width: minWidth + readNaturalTextWidth(label), minWidth };
}

/**
 * Writes the width limits of `fit`: `--open-tab-max-width` on `nav`, which the
 * stylesheet applies as the open tab's `max-width`, and the `max-width` of
 * each element in `crumbTexts`. A limit that is already written is left as it
 * is, and a `null` limit removes it, so a tab or a name is only ever
 * shortened when it has to be.
 */
function applyLimits(nav: HTMLElement, crumbTexts: readonly HTMLElement[], fit: PillFit): void {
  writeLength(nav, "--open-tab-max-width", fit.openTabMaxWidth);
  for (const [index, text] of crumbTexts.entries()) {
    writeLength(text, "max-width", fit.crumbTextMaxWidths[index]!);
  }
}

/**
 * Sets the inline style `property` of `element` to `pixels`, or removes it
 * for `null`. Writes nothing when the style already holds that value, so a
 * check that changes nothing does not invalidate the layout. The width is
 * rounded down to 1/100 of a pixel, so a limit never exceeds what was
 * computed.
 */
function writeLength(element: HTMLElement, property: string, pixels: number | null): void {
  const value = pixels === null ? "" : `${String(Math.floor(pixels * 100) / 100)}px`;
  if (element.style.getPropertyValue(property) === value) return;
  if (value === "") element.style.removeProperty(property);
  else element.style.setProperty(property, value);
}
