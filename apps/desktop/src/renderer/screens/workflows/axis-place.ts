/**
 * Places on a time axis, which the Runs tab's timeline and a run's step
 * timeline both draw as CSS percentages of the axis's width.
 */

/** Returns a place on an axis, from 0 to 1, as a CSS percentage: 0.25 is "25%". */
export const formatPlace = (place: number): string => `${String(place * 100)}%`;
