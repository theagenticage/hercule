/**
 * Readers for JSON whose shape nothing has checked: a plugin's schema, an
 * input's schema, the detail an adapter attached to a transcript item. Each
 * returns the value in the shape asked for, or `undefined` when it has
 * another shape, so a caller can read such JSON without casts.
 */

/** Returns the value as an object with string keys, or `undefined` for anything else, arrays too. */
export const readJsonObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Returns the value as a list of strings, or `undefined` when it is not an array of only strings. */
export const readStringList = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
