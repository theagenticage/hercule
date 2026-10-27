/**
 * The sizes the lists that sit beside an open item draw their headings and
 * rows at: Workflows, Discussions and Wiki. Each list places its items by
 * their heights, which follow the Text size, so the heights are read from the
 * custom properties of styles/row-heights.css that the rows' CSS draws them
 * at.
 */
import { readLengths } from "../../app/text-size";

/**
 * The custom property that holds each height, at the default Text size:
 *
 * - `groupHeading` is a group's heading, 24px;
 * - `repositoryHeading` is a repository's sub-heading, 22px;
 * - `oneLineRow` is a one-line row in the table, 40px;
 * - `twoLineRow` is a two-line row in the table, 52px;
 * - `columnRow` is a row in the column, two lines, 46px.
 */
export const LIST_HEIGHT_PROPERTIES = {
  groupHeading: "--list-height-group-heading",
  repositoryHeading: "--list-height-repository-heading",
  oneLineRow: "--list-height-one-line-row",
  twoLineRow: "--list-height-two-line-row",
  columnRow: "--list-height-column-row",
} as const;

/** The heights of the lists' headings and rows, in CSS pixels, without the space above them. */
export type ListHeights = Readonly<Record<keyof typeof LIST_HEIGHT_PROPERTIES, number>>;

/** Reads the heights of the lists' headings and rows from the page's CSS. */
export const readListHeights = (): ListHeights => readLengths(LIST_HEIGHT_PROPERTIES);

/** The space above each of the column's rows, in CSS pixels, as between the sidebar's rows. */
export const COLUMN_ROW_LEADING = 1;
