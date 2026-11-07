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
