/**
 * The themes the specimen sheets are drawn in. The sheets check their
 * `?theme=` against `ALL_THEMES`, and the capture scripts open each sheet once
 * per theme. The capture scripts run on Node and import this file by its
 * path, so it imports nothing.
 */

/**
 * The two themes the Bureau book draws its pages in, and so the two themes
 * `pnpm compare:bureau` compares the sheet of pieces in: Whitehaven (light)
 * and Orient Express (dark).
 */
export const THEMES = ["whitehaven", "orient-express"];

/**
 * All five Bureau themes, in the order tokens.css defines them. A capture for
 * a check by eye uses these, because the book draws no page in the
 * other three.
 */
export const ALL_THEMES = ["whitehaven", "styles", "orient-express", "nile", "end-house"];
