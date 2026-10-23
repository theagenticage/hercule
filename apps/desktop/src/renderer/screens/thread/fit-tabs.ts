/**
 * Picks which tabs of the header's pill to hide behind the "+n" button, so
 * that the pill fits in the room it has.
 *
 * Every width is in pixels and includes the gap the pill puts after the item,
 * so the widths can be added up as they are. The open tab and the waiting
 * tabs are "pinned": they stay as long as there is any way to keep them. The
 * pill gives way in this order:
 *
 * 1. Everything fits: nothing is hidden, and the "+n" button is not shown,
 *    so its width is not reserved.
 * 2. The tabs that are not pinned move behind "+n", as many as it takes. They
 *    fill the room that is left in start order: a tab that does not fit is
 *    hidden, but a later, narrower tab may still fit. The work's name keeps
 *    its natural width for this.
 * 3. When the pinned tabs do not fit beside the name, no unpinned tab stays,
 *    and the name shrinks (the stylesheet does it; here it counts as zero
 *    wide) to make room for them.
 * 4. When the pinned tabs do not fit even then, waiting tabs move behind "+n"
 *    too, and the ones that fit beside the open tab stay, in start order. The
 *    open tab never hides: when it is wider than the room, it overflows.
 *
 * Returns the indexes into `tabWidths` of the tabs to hide, empty when every
 * tab stays.
 */
export function pickHiddenTabs(layout: {
  /** The natural width of each tab, in start order. */
  readonly tabWidths: readonly number[];
  /** The index of the open tab, or `null` when no tab is open. */
  readonly openIndex: number | null;
  /** Whether each tab is waiting, in the order of `tabWidths`. */
  readonly waiting: readonly boolean[];
  /** The width of everything in the pill that is not a tab, the "+n" button or the work's name. */
  readonly fixedWidth: number;
  /** The natural width of the work's name, which can shrink to nothing. */
  readonly nameWidth: number;
  /** The width of the "+n" button. */
  readonly overflowWidth: number;
  /** The width the pill may take. */
  readonly room: number;
}): ReadonlySet<number> {
  const { tabWidths, openIndex, waiting, fixedWidth, nameWidth, overflowWidth, room } = layout;
  const sum = (widths: readonly number[]): number =>
    widths.reduce((total, width) => total + width, 0);
  if (fixedWidth + nameWidth + sum(tabWidths) <= room) return new Set();

  const isPinned = (index: number): boolean => index === openIndex || waiting[index] === true;
  const pinnedWidth = sum(tabWidths.filter((_, index) => isPinned(index)));
  const unpinned = [...tabWidths.keys()].filter((index) => !isPinned(index));

  // The unpinned tabs fill what the pinned ones and the name leave.
  const budget = room - fixedWidth - nameWidth - overflowWidth;
  if (pinnedWidth <= budget) {
    const hidden = new Set<number>();
    let used = pinnedWidth;
    for (const index of unpinned) {
      if (used + tabWidths[index]! <= budget) used += tabWidths[index]!;
      else hidden.add(index);
    }
    return hidden;
  }

  // The name gives way. The "+n" button is shown only if a tab is hidden.
  const hidden = new Set(unpinned);
  const roomForTabs = room - fixedWidth - (hidden.size > 0 ? overflowWidth : 0);
  if (pinnedWidth <= roomForTabs) return hidden;

  // The waiting tabs give way, the open tab stays.
  const budgetWithoutName = room - fixedWidth - overflowWidth;
  let used = openIndex === null ? 0 : tabWidths[openIndex]!;
  for (const [index, width] of tabWidths.entries()) {
    if (index === openIndex || !isPinned(index)) continue;
    if (used + width <= budgetWithoutName) used += width;
    else hidden.add(index);
  }
  return hidden;
}
