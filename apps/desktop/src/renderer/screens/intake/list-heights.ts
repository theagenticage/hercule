/**
 * The heights Intake's list and opened Tracking's list estimate their lines
 * at. Both draw their rows at their own height (a row's CSS sets only a
 * minimum), so the estimate sizes the spacers that stand in for the lines not
 * drawn. The heights follow the Text size, so they are read from the custom
 * properties of styles/row-heights.css that the CSS draws the lines at.
 */
import { readLengths } from "../../app/text-size";

/**
 * The custom property that holds each height, at the default Text size:
 *
 * - `section` is a section's heading, 40px;
 * - `signalRow` is a signal's row in Intake's list, 52px;
 * - `trackingRow` is a row of opened Tracking, 46px.
 */
const LIST_HEIGHT_PROPERTIES = {
  section: "--intake-height-section",
  signalRow: "--intake-height-row",
  trackingRow: "--tracking-height-row",
} as const;

/** The estimated heights of the lines of both lists, in CSS pixels, without the gap under a row. */
export type IntakeListHeights = Readonly<Record<keyof typeof LIST_HEIGHT_PROPERTIES, number>>;

/** Reads the heights of the lists' lines from the page's CSS. */
export const readIntakeListHeights = (): IntakeListHeights => readLengths(LIST_HEIGHT_PROPERTIES);

/** The gap under every row but the last of a section, in CSS pixels: the bottom margin of `.ask-item` and `.tr-run-item`. */
export const ROW_GAP = 2;
