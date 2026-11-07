/**
 * Plain text helpers for the controller: cutting a text to a length, and
 * keeping the end of a text. They know nothing of any domain, so any domain
 * may import this file. Lengths count characters as a string's `length`
 * does (UTF-16 code units), and no cut leaves half of an emoji behind.
 */

const ELLIPSIS = "…";

/** Removes the last character of `text` when it is the first half of a surrogate pair. */
const dropSplitPairEnd = (text: string): string => {
  const lastCode = text.charCodeAt(text.length - 1);
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? text.slice(0, -1) : text;
};

/**
 * Returns `text` unchanged when it has at most `limit` characters. Otherwise
 * returns a cut of it that ends with "…" and has at most `limit` characters,
 * the "…" included, so a contract that bounds the field by `limit` accepts
 * it. Characters are counted as the string's `length` counts them.
 *
 * The cut falls at the last paragraph break within the limit, else the last
 * line break, else the last space, else just short of the limit. Ending on a
 * break keeps a sentence or a list item from being torn in half. A break only
 * counts in the second half of the limit: a paragraph break at character 5 of
 * 1000 would throw away almost the whole text to save one word, so such a text
 * is cut at a later line break or space, or just short of the limit. The cut
 * never splits a surrogate pair, which would leave half an emoji.
 */
export const cutText = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const earliestBreak = limit / 2;
  const breaks = [head.lastIndexOf("\n\n"), head.lastIndexOf("\n"), head.search(/\s\S*$/)];
  const at = breaks.find((index) => index >= earliestBreak);
  if (at !== undefined) return head.slice(0, at).trimEnd() + ELLIPSIS;
  // One character is kept free for the ellipsis.
  return dropSplitPairEnd(head.slice(0, limit - 1)) + ELLIPSIS;
};

/**
 * Returns `text` unchanged when it has at most `limit` characters. Otherwise
 * returns a cut of it that ends with "…" and has at most `limit` characters,
 * the "…" included. Unlike `cutText`, the cut always falls at the end of a
 * word when the kept part holds a space or a line break, however early in
 * the text that is. Only a first word longer than the room is cut inside the
 * word, and then never inside a surrogate pair. It never refuses a text.
 */
export const cutTextAtWord = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  // One character is kept free for the ellipsis.
  const room = text.slice(0, Math.max(0, limit - 1));
  const endsAtWordEnd = /\s/.test(text.charAt(room.length));
  const lastBreak = room.search(/\s\S*$/);
  if (endsAtWordEnd || lastBreak >= 0) {
    return (endsAtWordEnd ? room : room.slice(0, lastBreak)).trimEnd() + ELLIPSIS;
  }
  return dropSplitPairEnd(room) + ELLIPSIS;
};

/**
 * Returns the last `max` characters of `text`, or `text` itself when it has at
 * most `max`. When the cut would start in the middle of a surrogate pair, the
 * lone second half is dropped, so the result can be one character shorter.
 */
export const takeTail = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const start = text.length - max;
  const startsInsidePair = /[\uDC00-\uDFFF]/.test(text.charAt(start));
  return text.slice(startsInsidePair ? start + 1 : start);
};
