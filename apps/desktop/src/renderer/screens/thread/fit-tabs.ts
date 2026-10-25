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
 *    hidden, but a later, narrower tab may still fit. The work's name and the
 *    crumbs' names keep their natural width for this.
 * 3. When the pinned tabs do not fit beside the name, no unpinned tab stays,
 *    and the work's name shrinks (it counts as zero wide) to make room for
 *    them.
 * 4. When they still do not fit, the crumbs' names shrink too (they count as
 *    zero wide). The pinned tabs then fit, and `fitPill` says how wide each
 *    crumb name may be.
 * 5. When the pinned tabs do not fit even then, waiting tabs move behind "+n"
 *    too, and the ones that fit beside the open tab stay, in start order. The
 *    open tab never hides: when it is wider than the room, `fitPill` shortens
 *    it.
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
  /** The width of everything in the pill that is not a tab, the "+n" button, the work's name or the text of a crumb. */
  readonly fixedWidth: number;
  /** The natural width of the work's name, which can shrink to nothing. */
  readonly nameWidth: number;
  /** The natural width of all the crumbs' names together, which can shrink to nothing after the work's name. */
  readonly crumbTextWidth: number;
  /** The width of the "+n" button. */
  readonly overflowWidth: number;
  /** The width the pill may take. */
  readonly room: number;
}): ReadonlySet<number> {
  const { tabWidths, openIndex, waiting, fixedWidth, nameWidth, crumbTextWidth, overflowWidth } =
    layout;
  const { room } = layout;
  const sum = (widths: readonly number[]): number =>
    widths.reduce((total, width) => total + width, 0);
  if (fixedWidth + nameWidth + crumbTextWidth + sum(tabWidths) <= room) return new Set();

  const isPinned = (index: number): boolean => index === openIndex || waiting[index] === true;
  const pinnedWidth = sum(tabWidths.filter((_, index) => isPinned(index)));
  const unpinned = [...tabWidths.keys()].filter((index) => !isPinned(index));

  // The unpinned tabs fill what the pinned ones and the names leave.
  const budget = room - fixedWidth - nameWidth - crumbTextWidth - overflowWidth;
  if (pinnedWidth <= budget) {
    const hidden = new Set<number>();
    let used = pinnedWidth;
    for (const index of unpinned) {
      if (used + tabWidths[index]! <= budget) used += tabWidths[index]!;
      else hidden.add(index);
    }
    return hidden;
  }

  // The work's name gives way, then the crumbs' names. The "+n" button is
  // shown only if a tab is hidden.
  const hidden = new Set(unpinned);
  const buttonWidth = hidden.size > 0 ? overflowWidth : 0;
  if (pinnedWidth <= room - fixedWidth - buttonWidth) return hidden;

  // The waiting tabs give way, the open tab stays.
  const budgetWithoutNames = room - fixedWidth - overflowWidth;
  let used = openIndex === null ? 0 : tabWidths[openIndex]!;
  for (const [index, width] of tabWidths.entries()) {
    if (index === openIndex || !isPinned(index)) continue;
    if (used + width <= budgetWithoutNames) used += width;
    else hidden.add(index);
  }
  return hidden;
}

/**
 * Shares `room` among names of the natural `widths`. A name keeps its natural
 * width while they all fit. Otherwise the widest names shrink to one common
 * width, so the shortest names are the last to be cut. Returns the width each
 * name may take, in the order of `widths`, or `null` for a name that keeps
 * its natural width.
 */
function shareRoom(widths: readonly number[], room: number): (number | null)[] {
  let remainingRoom = room;
  let remainingCount = widths.length;
  let level = Infinity;
  for (const width of [...widths].sort((a, b) => a - b)) {
    if (width * remainingCount <= remainingRoom) {
      remainingRoom -= width;
      remainingCount -= 1;
    } else {
      level = remainingRoom / remainingCount;
      break;
    }
  }
  return widths.map((width) => (width <= level ? null : level));
}

/** What the pill must do to fit in its room, from `fitPill`. */
export interface PillFit {
  /** The indexes of the tabs to hide behind "+n". */
  readonly hiddenIndexes: ReadonlySet<number>;
  /**
   * The width the open tab may take, in pixels, or `null` when it may take
   * its natural width. The tab ellipsizes its label to this width.
   */
  readonly openTabMaxWidth: number | null;
  /**
   * The width each crumb name may take, in pixels, in the order of the
   * `crumbTextWidths` it was given, or `null` where the name may take its
   * natural width.
   */
  readonly crumbTextMaxWidths: readonly (number | null)[];
}

/**
 * Decides how the header's pill fits in its room: which tabs hide behind
 * "+n" (`pickHiddenTabs`), how wide the crumbs' names may be, and how wide
 * the open tab may be. The pill gives way in the order the ticket gives:
 * other tabs, the work's name, the crumbs' names, waiting tabs, and last the
 * open tab's label.
 *
 * The caller measures the widths without the limits that this function
 * returned before: every width is the natural one. The result is then a
 * function of the natural widths and the room alone, so applying it changes
 * nothing it is measured from, and the next check returns the same result.
 * Measuring a width that a limit shortened would make the limit come and go,
 * and the pill would never settle.
 *
 * The crumbs' names share the room that is left by the widest first: the
 * widest shrink to a common width before a shorter one is cut. The work's
 * name has no limit here, because the stylesheet shrinks it to
 * what the room leaves, down to nothing.
 */
export function fitPill(layout: {
  /** As in `pickHiddenTabs`. */
  readonly tabWidths: readonly number[];
  readonly openIndex: number | null;
  readonly waiting: readonly boolean[];
  readonly fixedWidth: number;
  readonly nameWidth: number;
  readonly overflowWidth: number;
  readonly room: number;
  /** The natural width of each crumb name, in the order the crumbs are drawn. */
  readonly crumbTextWidths: readonly number[];
  /** The gap the pill puts between two parts. */
  readonly gap: number;
  /**
   * The narrowest the open tab can be drawn, without the gap after it: its
   * padding, mark and the like, with the label shortened to nothing. A tab
   * cannot be limited below this, so a pill in a room smaller than the
   * parts that cannot shrink add up to is wider than its room.
   */
  readonly openTabMinWidth: number;
}): PillFit {
  const { tabWidths, openIndex, crumbTextWidths, gap, openTabMinWidth } = layout;
  const crumbTextWidth = crumbTextWidths.reduce((total, width) => total + width, 0);
  const hiddenIndexes = pickHiddenTabs({ ...layout, crumbTextWidth });

  // What the room leaves after every part that cannot shrink: the tabs that
  // stay, "+n" when it shows, and the pill's fixed parts. Negative when even
  // the work's name and the crumbs' names at zero width leave too little.
  const visibleTabsWidth = tabWidths
    .filter((_, index) => !hiddenIndexes.has(index))
    .reduce((total, width) => total + width, 0);
  const buttonWidth = hiddenIndexes.size > 0 ? layout.overflowWidth : 0;
  const leftover = layout.room - layout.fixedWidth - buttonWidth - visibleTabsWidth;

  let openTabMaxWidth: number | null = null;
  if (openIndex !== null && leftover < 0) {
    const limit = Math.max(openTabMinWidth, tabWidths[openIndex]! + leftover - gap);
    if (limit < tabWidths[openIndex]! - gap) openTabMaxWidth = limit;
  }

  // The crumbs' names come before the work's name in what the room leaves.
  const crumbTextMaxWidths = shareRoom(crumbTextWidths, Math.max(0, leftover));
  return { hiddenIndexes, openTabMaxWidth, crumbTextMaxWidths };
}
