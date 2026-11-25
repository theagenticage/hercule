/**
 * Joins names the way a sentence lists alternatives: "a", "a or b", "a, b or
 * c". Returns an empty text for no names.
 */
export const joinNamesWithOr = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)!}`;
