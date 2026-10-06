/**
 * The themes the specimen sheets are drawn in. The sheets check their
 * `?theme=` against `ALL_THEMES`, and the capture scripts open each sheet once
 * per theme. The capture scripts run on Node and import this file by its
 * path, so it imports nothing.
 */

/**
 * The two themes every sheet is compared with the Bureau book in: Whitehaven
 * (light) and Orient Express (dark). The book draws its pages in these two.
 */
export const THEMES = ["whitehaven", "orient-express"];

/**
 * All five Bureau themes, in the order tokens.css defines them. A capture for
 * a check by eye uses these, because the book draws no page to compare the
 * other three with.
 */
export const ALL_THEMES = ["whitehaven", "styles", "orient-express", "nile", "end-house"];
