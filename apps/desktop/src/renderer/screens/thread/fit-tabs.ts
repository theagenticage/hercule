/**
 * Picks which tabs of the header's pill to hide behind the "+n" button, so
 * that the pill fits in the room it has.
 *
 * Every width is in pixels and includes the gap the pill puts after the item,
 * so the widths can be added up as they are.
 *
 * - When everything fits, nothing is hidden and the "+n" button is not shown,
 *   so its width is not reserved.
 * - Otherwise the "+n" button is shown and its width is reserved. The pinned
 *   tabs (the open tab and every waiting tab) stay, even when they alone are
 *   wider than the room. The other tabs fill what is left in start order: a
 *   tab that does not fit is hidden, but a later, narrower tab may still fit.
 *
 * Returns the indexes into `tabWidths` of the tabs to hide, empty when every
 * tab stays.
 */
export function pickHiddenTabs(layout: {
  /** The natural width of each tab, in start order. */
  readonly tabWidths: readonly number[];
  /** Whether each tab must stay visible, in the order of `tabWidths`. */
  readonly pinned: readonly boolean[];
  /** The width of everything in the pill that is not a tab and not the "+n" button. */
  readonly fixedWidth: number;
  /** The width of the "+n" button. */
  readonly overflowWidth: number;
  /** The width the pill may take. */
  readonly room: number;
}): ReadonlySet<number> {
  const { tabWidths, pinned, fixedWidth, overflowWidth, room } = layout;
  const tabsWidth = tabWidths.reduce((sum, width) => sum + width, 0);
  if (fixedWidth + tabsWidth <= room) return new Set();

  const budget = room - fixedWidth - overflowWidth;
  let used = 0;
  for (const [index, width] of tabWidths.entries()) {
    if (pinned[index]) used += width;
  }
  const hidden = new Set<number>();
  for (const [index, width] of tabWidths.entries()) {
    if (pinned[index]) continue;
    if (used + width <= budget) used += width;
    else hidden.add(index);
  }
  return hidden;
}
