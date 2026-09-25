/**
 * Splits a JSON value into the lines of its indented text, each with its
 * depth apart from its text. A narrow card wraps a long line, and a wrapped
 * line keeps its indent only when the card knows each line's depth.
 */

/** One line of a JSON value's indented text. */
export interface JsonLine {
  /** How many levels deep the line is indented. */
  readonly depth: number;
  /** The line without its indent. */
  readonly text: string;
}

/** The spaces of one level of indent, as `JSON.stringify` writes it with an indent of 2. */
const INDENT = 2;

/**
 * Returns the lines of a JSON value's text indented two spaces a level, as
 * `JSON.stringify(value, null, 2)` writes it, each with its depth and its
 * text without the indent.
 */
export const listJsonLines = (value: unknown): ReadonlyArray<JsonLine> =>
  JSON.stringify(value, null, INDENT)
    .split("\n")
    .map((line) => {
      const text = line.trimStart();
      return { depth: (line.length - text.length) / INDENT, text };
    });
