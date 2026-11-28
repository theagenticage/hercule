/**
 * Icons for the statuses of a Sentry issue, as filled paths on the 16x16 grid.
 *
 * Each icon is the outline of a 1.5 wide stroke with round caps and joins, so
 * it covers the same pixels as the stroked drawing it comes from:
 *
 * - `NEW_ICON` is the alert shape of the desktop app's core status shapes (a
 *   triangle, a bar and a dot, see `status-shape.tsx`). The triangle is an
 *   outer outline with an inner outline wound the other way, which cuts it
 *   out. The bar is a stadium. The dot is filled and has no stroke.
 * - `REGRESSED_ICON` is the "return" arrow of the Inbox drawing, which is on
 *   a 14 unit grid. Every coordinate is scaled by 16/14 and the stroke stays
 *   1.5, the weight of the core shapes. The open arc is a band with round
 *   ends, the arrow head is two bands that overlap in a round corner.
 */
import type { StatusIcon } from "@hercule/plugin-host";

/** Sentry's hue in OKLCH degrees: its brand purples measure 285 to 291. */
export const SENTRY_HUE = 288;

/** An alert triangle with a bang: an issue that is new. */
export const NEW_ICON: StatusIcon = {
  paths: [
    "M8.65 2.23L14.55 12.63A0.75 0.75 0 0 1 13.9 13.75L2.1 13.75A0.75 0.75 0 0 1 1.45 12.63L7.35 2.23A0.75 0.75 0 0 1 8.65 2.23ZM8 4.12L3.39 12.25L12.61 12.25Z",
    "M7.25 6.6A0.75 0.75 0 0 1 8.75 6.6L8.75 9.6A0.75 0.75 0 0 1 7.25 9.6Z",
    "M8 10.65A0.55 0.55 0 1 1 8 11.75A0.55 0.55 0 1 1 8 10.65Z",
  ],
};

/** A return arrow: an issue that came back after it was resolved. */
export const REGRESSED_ICON: StatusIcon = {
  paths: [
    "M13.63 9.83A5.89 5.89 0 1 1 11.8 3.54A0.75 0.75 0 0 1 10.83 4.69A4.39 4.39 0 1 0 12.2 9.37A0.75 0.75 0 0 1 13.63 9.83Z",
    "M12.64 1.6L12.64 4.57A0.75 0.75 0 0 1 11.14 4.57L11.14 1.6A0.75 0.75 0 0 1 12.64 1.6ZM11.89 5.32L8.91 5.32A0.75 0.75 0 0 1 8.91 3.82L11.89 3.82A0.75 0.75 0 0 1 11.89 5.32Z",
  ],
};
