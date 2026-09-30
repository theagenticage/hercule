/**
 * The two themes every specimen sheet is drawn and compared in: Whitehaven
 * (light) and Orient Express (dark). The sheets check their `?theme=`
 * against this list, and the capture scripts open each sheet once per theme.
 * The capture scripts run on Node and import this file by its path, so it
 * imports nothing.
 */
export const THEMES = ["whitehaven", "orient-express"];
