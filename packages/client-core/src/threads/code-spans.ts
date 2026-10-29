/** One stretch of a message: plain text, or the text between a pair of backticks. */
interface MessagePart {
  readonly kind: "text" | "code";
  readonly text: string;
}

/**
 * The longest word of a command, in characters, that a screen keeps whole
 * when it draws the command in an error note or a warning note. A longer word,
 * such as a long path or URL, may break anywhere, so it can never overflow
 * the note or leave a gap before it.
 *
 * A note is at its narrowest on a 360px wide web screen, where its text has
 * 277px, and in a desktop window at its smallest width, where it has about
 * 400px. The code is in a monospace font at 0.6 times its size: 7px a
 * character on the web (11.5px) and 7.2px on the desktop (12px). A chip adds
 * 8px to 10px of padding. So the narrowest note holds (277 - 8) / 7, or 38,
 * characters, and this is 36: it keeps a 36 character id whole, with 17px to
 * spare on the web.
 */
export const MAX_UNBROKEN_CODE_WORD = 36;

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
