/** How this plugin fits text it writes into the limits the host checks. */

/**
 * Cuts text to `maximum` characters, ending it with an ellipsis when it was
 * cut. The cut never splits a character that takes two UTF-16 units, such as
 * an emoji, because half of one is not text.
 */
export const cutText = (text: string, maximum: number): string => {
  if (text.length <= maximum) return text;
  const end = maximum - 1;
  const splitsPair = /[\uD800-\uDBFF]/.test(text.charAt(end - 1));
  return `${text.slice(0, splitsPair ? end - 1 : end)}…`;
};
