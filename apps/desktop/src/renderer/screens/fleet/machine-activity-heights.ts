/**
 * The heights the Activity page's list draws its lines at. The list places
 * its lines by these heights and never measures one, so each line is drawn at
 * exactly its height, and every text in a line is cut with an ellipsis rather
 * than wrapped. The heights follow the Text size, so they are read from the
 * custom properties of styles/row-heights.css that the CSS draws the lines
 * at.
 */
import { readLengths } from "../../app/text-size";

/**
 * The custom property that holds each height, at the default Text size:
 *
 * - `day` is a day's heading with the space around it, 48px;
 * - `entry` is an entry, 35px;
 * - `detail` is a line of an unfolded entry, 19px;
 * - `lastDetail` is the last line of an unfolded entry, which has room below
 *   it, 28px.
 */
const ACTIVITY_HEIGHT_PROPERTIES = {
  day: "--fleet-activity-height-day",
  entry: "--fleet-activity-height-entry",
  detail: "--fleet-activity-height-member",
  lastDetail: "--fleet-activity-height-last-member",
} as const;

/** The heights of the Activity list's lines, in CSS pixels. */
export type MachineActivityHeights = Readonly<
  Record<keyof typeof ACTIVITY_HEIGHT_PROPERTIES, number>
>;

/** Reads the heights of the Activity list's lines from the page's CSS. */
export const readMachineActivityHeights = (): MachineActivityHeights =>
  readLengths(ACTIVITY_HEIGHT_PROPERTIES);
