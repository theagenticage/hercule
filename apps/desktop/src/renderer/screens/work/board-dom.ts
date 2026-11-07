/** Returns whether a lane shows folded: its line of counts stands where its cells would. */
export const isLaneFolded = (lane: Element): boolean =>
  lane.querySelector(":scope > [data-fold-row]") !== null;

/** Returns the line under the cards of `cell` ("13 more" or "3 landed"), or `null` when it has none. */
export const findCellFoot = (cell: Element): HTMLElement | null =>
  [...cell.children].find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains("board-more"),
  ) ?? null;
