/** One stretch of a message: plain text, or the text between a pair of backticks. */
interface MessagePart {
  readonly kind: "text" | "code";
  readonly text: string;
}

/**
 * A code span as CommonMark has it: a run of backticks, the text, and a run of
 * the same length. The runs must stand alone, so a run of two never closes a
 * run of three. This is what makes an empty pair (two backticks in a row)
 * plain text: it has no closing run of two after it, and its second backtick
 * cannot open a span of its own.
 */
const CODE_SPAN = /(?<!`)(`+)(?!`)([\s\S]+?)(?<!`)\1(?!`)/g;

/**
 * Splits a message into plain text and code parts. A code part is the text
 * between a pair of backticks, without the backticks. A backtick with no
 * partner, and an empty pair, stay in the text as written. A run of several
 * backticks opens a code part that only a run of the same length closes, so
 * the part can hold a single backtick. The parts joined
 * in order, with the backticks put back around each code part, give the
 * message again. Returns no parts for an empty message.
 *
 * The runner ends some error messages with a command to run, set in
 * backticks, so a screen can draw that command as code.
 */
export const splitCodeSpans = (message: string): ReadonlyArray<MessagePart> => {
  const parts: Array<MessagePart> = [];
  let textStart = 0;
  for (const match of message.matchAll(CODE_SPAN)) {
    if (match.index > textStart) {
      parts.push({ kind: "text", text: message.slice(textStart, match.index) });
    }
    parts.push({ kind: "code", text: match[2]! });
    textStart = match.index + match[0].length;
  }
  if (textStart < message.length) parts.push({ kind: "text", text: message.slice(textStart) });
  return parts;
};
