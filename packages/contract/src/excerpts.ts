/**
 * Helpers that keep error messages short when they include long text: a quote
 * of what the author wrote, a list of names, or a message from a library. An
 * error response has one message per problem, so messages that repeated a long
 * value in full could make the response as large as the request, once per
 * problem. The workflow validators and the validation of a subscription's
 * condition build their messages with these helpers.
 */

/**
 * Returns the first `max` characters of `text`, followed by "..." if the text
 * is longer. Never cuts between the two halves of a surrogate pair, because
 * half a pair is not a valid character.
 */
export const truncateText = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return `${text.slice(0, end)}...`;
};

/** The maximum number of characters of the author's text that a message quotes. */
export const MAX_QUOTED_LENGTH = 40;

/**
 * Returns the author's text as a JSON string in double quotes, truncated to
 * `MAX_QUOTED_LENGTH` characters. Every message about a workflow or an
 * expression quotes the author's text with this function, lists names with
 * `joinNames`, and includes a library's message with `shortenLibraryMessage`. So no
 * message grows with the size of what the author wrote.
 */
export const quoteAuthorText = (text: string): string =>
  JSON.stringify(truncateText(text, MAX_QUOTED_LENGTH));

/** The maximum number of names that a message lists. */
const MAX_LISTED_NAMES = 5;

/**
 * Joins names into an English list: `a`, `a and b`, `a, b and c`. With more
 * than `MAX_LISTED_NAMES` names, returns the first ones and a count of the
 * rest, such as `a, b, c, d, e and 3 more`, so a message does not grow with
 * the number of names.
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

/** The maximum number of characters of a library's message that an error message repeats. */
const MAX_LIBRARY_MESSAGE_LENGTH = 120;

/**
 * Returns a library's message (from the YAML parser, the schema library or the
 * expression evaluator) as one sentence to include in an error message. The
 * library's message can repeat what the author wrote, so it is truncated like
 * a quote. The result ends with exactly one full stop: none is added after a
 * message that already ends in punctuation or in the "..." of a cut.
 */
export const shortenLibraryMessage = (message: string): string => {
  const excerpt = truncateText(message, MAX_LIBRARY_MESSAGE_LENGTH);
  return /[.!?]$/.test(excerpt) ? excerpt : `${excerpt}.`;
};
