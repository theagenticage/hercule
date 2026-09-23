/**
 * Short excerpts of long text, for the messages of a refusal: a quote of what
 * an author wrote, a list of the author's names, and one sentence of what a
 * library said. A refusal names each problem with its own message, so a
 * message that repeated a long value in full would make the refusal as large
 * as the request, once for each problem. The checks of a workflow and the
 * check of a subscription's condition write their messages through these.
 */

/**
 * The first `max` characters of a text, and "..." after them where the text
 * is longer. The cut never falls between the two halves of a surrogate pair,
 * because half of a pair is not a character.
 */
export const cutShort = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return `${text.slice(0, end)}...`;
};

/** The most characters of what the author wrote that a message quotes. */
export const MAX_QUOTED_LENGTH = 40;

/**
 * Text the author wrote, in quotes, cut short where it is long. Every message
 * about a workflow or an expression quotes the author's text through this,
 * lists the author's names through `joinNames`, and repeats a library's words
 * through `excerptMessage`, so no message grows with what the author wrote.
 */
export const quoteWritten = (text: string): string =>
  JSON.stringify(cutShort(text, MAX_QUOTED_LENGTH));

/** The most names that a message lists. */
const MAX_LISTED_NAMES = 5;

/**
 * Names in an English list: `a`, `a and b`, `a, b and c`. A list of more than
 * `MAX_LISTED_NAMES` names gives the first ones and the number of the others,
 * such as `a, b, c, d, e and 3 more`, so a message does not grow with the
 * number of names that the author wrote.
 */
export const joinNames = (names: ReadonlyArray<string>): string => {
  const listed =
    names.length <= MAX_LISTED_NAMES
      ? names
      : [...names.slice(0, MAX_LISTED_NAMES), `${String(names.length - MAX_LISTED_NAMES)} more`];
  return listed.length <= 1
    ? listed.join("")
    : `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)!}`;
};

/** The most characters of a message from a library that a refusal repeats. */
const MAX_LIBRARY_MESSAGE_LENGTH = 120;

/**
 * A message that a library wrote, such as the YAML parser, the schema library
 * or the expression evaluator, as one sentence of a refusal. The library's
 * words can repeat what the author wrote, so they are cut short, as a quote of
 * the author's text is. The sentence ends with one full stop: a message that
 * ends in punctuation, or in the dots of a cut, gets no second one.
 */
export const excerptMessage = (message: string): string => {
  const excerpt = cutShort(message, MAX_LIBRARY_MESSAGE_LENGTH);
  return /[.!?]$/.test(excerpt) ? excerpt : `${excerpt}.`;
};
