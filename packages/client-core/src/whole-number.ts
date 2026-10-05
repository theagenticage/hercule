/**
 * Parses a whole number from text the user typed into a form field, such as
 * a feed's poll interval.
 *
 * Returns the number when the text, with spaces around it removed, is only
 * digits. Returns `undefined` for anything else: empty text, "abc", "1.5",
 * "-5", "1e3" or "0x10". `Number` alone would read the last two as 1000 and
 * 16, and the form would save a number the user did not type.
 */
export const parseWholeNumber = (text: string): number | undefined => {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
};
