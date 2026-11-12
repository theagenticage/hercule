/**
 * Moves the keyboard focus between the Inbox's regions (F6): the search, the
 * rail (or the scope button that holds it when the rail is folded away), the
 * list and the pane, in that order. Under 1032px the list and the pane share
 * one place, whichever of them shows. An empty list's place is its empty
 * state's heading.
 */
import { INBOX_REGION_IDS } from "./inbox-frame";

/** Where the layout leaves the list and the pane: one place under 1032px, so F6 visits only the one that shows. */
export interface InboxRegionLayout {
  readonly isStacked: boolean;
  readonly isPaneOpen: boolean;
}

const FOCUSABLE = "button, a[href], input, [tabindex]:not([tabindex='-1'])";

/** Returns whether `element` can take the focus now: it is not inert or hidden, itself or through a parent. */
const isReachable = (element: HTMLElement | null): element is HTMLElement =>
  element !== null && element.closest("[inert], [hidden]") === null;

const findElementById = (id: string): HTMLElement | null => document.getElementById(id);

/** The regions in the order F6 visits them, each with the element that takes the focus and the element that holds it. */
const readRegions = (
  layout: InboxRegionLayout,
): ReadonlyArray<{ readonly holder: HTMLElement | null; readonly stop: HTMLElement | null }> => {
  const rail = findElementById(INBOX_REGION_IDS.rail);
  const scopeButton = findElementById(INBOX_REGION_IDS.scopeButton);
  const list = findElementById(INBOX_REGION_IDS.list);
  const pane = findElementById(INBOX_REGION_IDS.pane);
  const regions = [
    {
      holder: findElementById(INBOX_REGION_IDS.search),
      stop: findElementById(INBOX_REGION_IDS.search)?.querySelector<HTMLElement>("input") ?? null,
    },
    scopeButton !== null
      ? { holder: scopeButton, stop: scopeButton }
      : { holder: rail, stop: rail?.querySelector<HTMLElement>("[tabindex='0']") ?? null },
    {
      holder: list,
      stop:
        list?.querySelector<HTMLElement>(".ib-rows [tabindex='0']") ??
        list?.querySelector<HTMLElement>(".ib-em-title") ??
        null,
    },
    { holder: pane, stop: pane?.querySelector<HTMLElement>(FOCUSABLE) ?? null },
  ];
  if (!layout.isStacked) return regions;
  return layout.isPaneOpen
    ? regions.filter((_, at) => at !== 2)
    : regions.filter((_, at) => at !== 3);
};

/**
 * Puts the focus on the next region after the one that holds the focus now,
 * or the previous one with `backwards`, and wraps round. A region that is
 * hidden or out of reach is passed over. With the focus in none of them, the
 * first (or last) region takes it.
 */
export const focusNextInboxRegion = (backwards: boolean, layout: InboxRegionLayout): void => {
  const regions = readRegions(layout).filter(
    (region) => isReachable(region.holder) && isReachable(region.stop),
  );
  if (regions.length === 0) return;
  const active = document.activeElement;
  const at = regions.findIndex((region) => region.holder?.contains(active) === true);
  const step = backwards ? -1 : 1;
  const next = regions[(at + step + regions.length) % regions.length];
  next?.stop?.focus({ preventScroll: true });
};
