/**
 * The rules for agent text: text that another agent wrote, such as a Wiki
 * Page's title and body or a Post, and that Hercule shows to someone else.
 *
 * An agent's words reach other agents' prompts and people's terminals. Written
 * with control characters, invisible characters, quotes or marker lines, they
 * could hide text, reorder it, or pass for text Hercule wrote itself. These
 * rules live in one module, so every caller cleans agent text the same way and
 * none forgets a rule.
 *
 * Which function to use where:
 *
 * - `removeTerminalControls` for any text printed to a terminal. The CLI uses
 *   it for all of its human output, not only for agent text;
 * - `escapeMarkerLines` for agent text printed between two `---` marker lines;
 * - `flattenToOneLine` for text put on one line of a prompt;
 * - `prepareForQuoting` for agent text put between quotes in a prompt.
 */

/**
 * The characters a terminal acts on rather than prints:
 *
 * - the C0 control characters and DEL, except tab and line feed, which
 *   multi-line text such as a notification's body needs. ESC starts the
 *   sequences that move the cursor, erase a line or hide text, and a carriage
 *   return lets later text overwrite the start of a line;
 * - the C1 control characters, U+0080 to U+009F. Some terminals read U+009B as
 *   ESC followed by `[`;
 * - the Unicode bidirectional controls, which can reorder the text that
 *   follows them on screen: the embeddings and overrides U+202A to U+202E, the
 *   isolates U+2066 to U+2069, and the marks U+200E, U+200F and U+061C;
 * - the tag characters U+E0000 to U+E007F, which a terminal shows as nothing
 *   while a model reading the same output reads them as text.
 */
const TERMINAL_CONTROLS =
  // Matching control characters is the point of this pattern.
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/gu;

/**
 * Removes the characters a terminal would act on rather than print, keeping
 * tabs and line breaks. Much of what the CLI prints was written by someone
 * other than the user, such as an agent's notification or an answer's label.
 * Printed as it is, an escape sequence in that text could erase or hide a
 * line, such as the line describing what an answer does.
 */
export const removeTerminalControls = (text: string): string => text.replace(TERMINAL_CONTROLS, "");

/**
 * Returns a text another agent wrote, such as a Post or a Wiki Page's body,
 * ready to print between two marker lines that start with `---`:
 *
 * - the characters a terminal would act on are removed first, so none of
 *   them can hide a marker from the next step and vanish afterwards;
 * - then a backslash is put before the `---` of every line that starts with
 *   it, after any spaces and backslashes already there.
 *
 * So no line of the text can pass for a marker and make what follows look
 * like it is outside the text. Each escaped line has exactly one backslash
 * more than it was written with, so a reader removes one to get the line.
 */
export const escapeMarkerLines = (text: string): string =>
  removeTerminalControls(text).replace(/^([^\S\n]*)(\\*)---/gm, "$1\\$2---");

/**
 * Returns a text made safe to put on one line of a prompt:
 *
 * - every run of whitespace, line breaks and Unicode line and paragraph
 *   separators included, becomes one space;
 * - every other control, format, private-use or unassigned character is
 *   removed. That covers zero-width, bidi and tag characters, which a person
 *   reading the text would not see;
 * - spaces at the start and end are removed.
 */
export const flattenToOneLine = (text: string): string =>
  text
    .replace(/[\s\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\p{C}/gu, "")
    .trim();

/** Every opening and closing quote, the plain quotes and their full-width forms, backticks and semicolons. */
const QUOTING = /[\p{Pi}\p{Pf}"'`;\uff02\uff07]/gu;

/**
 * Returns agent text, such as a Wiki Page's title, ready for the caller to put
 * between quotes in a prompt. The returned text has no quotes around it:
 *
 * - every quoting character is removed, so the text cannot end its quotes or
 *   pass for a separate item of a list;
 * - the text is flattened to one line by `flattenToOneLine`;
 * - the text is cut to `maxLength` code points, so a cut never splits a
 *   character in two.
 */
export const prepareForQuoting = (text: string, maxLength: number): string =>
  Array.from(flattenToOneLine(text.replace(QUOTING, "")))
    .slice(0, maxLength)
    .join("");
