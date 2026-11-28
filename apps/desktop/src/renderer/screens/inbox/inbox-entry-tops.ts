import type { InboxListEntry } from "./inbox-list-entry";

/** The height of a group's "Show N more" line in pixels (`.ib-group-more` in `inbox-group-row.css`). Every other line is a full row. */
const MORE_LINE_HEIGHT = 32;

/** Returns the height in pixels of the line that draws `entry`, given the height of a full row. */
export const readEntryHeight = (entry: InboxListEntry, rowHeight: number): number =>
  entry.kind === "more" ? MORE_LINE_HEIGHT : rowHeight;

/**
 * Returns where each line starts, in pixels from the top of the rows: the
 * entry at `index` starts at `tops[index]`, and the last number is the height
 * of all the lines. Lines are not all one height, because a group's "Show N
 * more" line is shorter than a row.
 */
export const buildEntryTops = (
  entries: ReadonlyArray<InboxListEntry>,
  rowHeight: number,
): ReadonlyArray<number> => {
  const tops: number[] = [0];
  for (const entry of entries)
    tops.push(tops[tops.length - 1]! + readEntryHeight(entry, rowHeight));
  return tops;
};
