/** Small pieces of text handling that the words of several screens share. */

/**
 * Returns `text` cut so that it is at most `mostCharacters` long, counting the
 * ellipsis that ends a cut text. Text that already fits comes back as it is.
 * A cut never leaves a space before the ellipsis, and never splits a character
 * that takes two UTF-16 code units (such as an emoji).
 */
export const cutWithEllipsis = (text: string, mostCharacters: number): string => {
  if (text.length <= mostCharacters) return text;
  let end = mostCharacters - 1;
  const lastKept = text.charCodeAt(end - 1);
  const isFirstHalfOfPair = lastKept >= 0xd800 && lastKept <= 0xdbff;
  if (isFirstHalfOfPair) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
};

/**
 * Returns `text` without the full stops at its end. Used on a reason that a
 * sentence quotes and then ends with a full stop of its own.
 */
export const dropClosingFullStops = (text: string): string => text.replace(/\.+$/, "");

/**
 * Returns `text` ending in a full stop, so a sentence can follow it. Text that
 * already ends in a full stop, "!" or "?" comes back as it is.
 */
export const endSentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * Returns `text` with its first letter in lower case: "Review requested"
 * becomes "review requested". Text that starts with an acronym, such as
 * "FYI", is returned unchanged, because "fYI" would misspell it.
 */
export const lowerFirst = (text: string): string =>
  /^\p{Lu}{2}/u.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1);
