/**
 * Icons for the states of a Linear issue, drawn after the ones Linear shows,
 * and Linear's colours for them, so a status reads the way it does in Linear.
 *
 * The icons are drawn for Hercule on the 16x16 grid, as filled paths: a ring
 * is an outer circle with an inner circle cut out of it, and a check or a
 * cross is cut out of a disc. The colours are the ones Linear gives the
 * states of a new team. A grey state has no colour of its own, so the app
 * draws it in the grey of the theme.
 */
import type { ExactColor, StatusIcon } from "@hercule/plugin-host";

/** A dashed ring: Backlog and Triage. */
export const BACKLOG_ICON: StatusIcon = {
  paths: [
    "M8.87 1.81A6.25 6.25 0 0 1 11.76 3.01L10.86 4.21A4.75 4.75 0 0 0 8.66 3.3ZM12.99 4.24A6.25 6.25 0 0 1 14.19 7.13L12.7 7.34A4.75 4.75 0 0 0 11.79 5.14ZM14.19 8.87A6.25 6.25 0 0 1 12.99 11.76L11.79 10.86A4.75 4.75 0 0 0 12.7 8.66ZM11.76 12.99A6.25 6.25 0 0 1 8.87 14.19L8.66 12.7A4.75 4.75 0 0 0 10.86 11.79ZM7.13 14.19A6.25 6.25 0 0 1 4.24 12.99L5.14 11.79A4.75 4.75 0 0 0 7.34 12.7ZM3.01 11.76A6.25 6.25 0 0 1 1.81 8.87L3.3 8.66A4.75 4.75 0 0 0 4.21 10.86ZM1.81 7.13A6.25 6.25 0 0 1 3.01 4.24L4.21 5.14A4.75 4.75 0 0 0 3.3 7.34ZM4.24 3.01A6.25 6.25 0 0 1 7.13 1.81L7.34 3.3A4.75 4.75 0 0 0 5.14 4.21Z",
  ],
};

/** An empty ring: Todo. */
export const TODO_ICON: StatusIcon = {
  paths: [
    "M8 1.75A6.25 6.25 0 1 1 8 14.25A6.25 6.25 0 1 1 8 1.75ZM8 3.25A4.75 4.75 0 1 0 8 12.75A4.75 4.75 0 1 0 8 3.25Z",
  ],
};

/** A ring half filled: In Progress. */
export const STARTED_ICON: StatusIcon = {
  paths: [
    "M8 1.75A6.25 6.25 0 1 1 8 14.25A6.25 6.25 0 1 1 8 1.75ZM8 3.25A4.75 4.75 0 1 0 8 12.75A4.75 4.75 0 1 0 8 3.25ZM8 8V5A3 3 0 0 1 8 11Z",
  ],
};

/** A ring three quarters filled: In Review. */
export const REVIEW_ICON: StatusIcon = {
  paths: [
    "M8 1.75A6.25 6.25 0 1 1 8 14.25A6.25 6.25 0 1 1 8 1.75ZM8 3.25A4.75 4.75 0 1 0 8 12.75A4.75 4.75 0 1 0 8 3.25ZM8 8V5A3 3 0 1 1 5 8Z",
  ],
};

/** A disc with a check cut out of it: Done. */
export const DONE_ICON: StatusIcon = {
  paths: [
    "M8 1.25A6.75 6.75 0 1 1 8 14.75A6.75 6.75 0 1 1 8 1.25ZM4.58 8.69L7.12 11.1L11.44 6.67L10.36 5.63L7.08 9L5.62 7.61Z",
  ],
};

/** A disc with a cross cut out of it: Canceled and Duplicate. */
export const CANCELED_ICON: StatusIcon = {
  paths: [
    "M8 1.25A6.75 6.75 0 1 1 8 14.75A6.75 6.75 0 1 1 8 1.25ZM6.34 10.72L8 9.06L9.66 10.72L10.72 9.66L9.06 8L10.72 6.34L9.66 5.28L8 6.94L6.34 5.28L5.28 6.34L6.94 8L5.28 9.66Z",
  ],
};

/** The yellow of a started state. */
export const STARTED_COLOR: ExactColor = "#f2c94c";

/** The green of a state in review. */
export const REVIEW_COLOR: ExactColor = "#4cb782";

/** The indigo of a completed state. */
export const DONE_COLOR: ExactColor = "#5e6ad2";
