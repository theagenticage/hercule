/**
 * The grammar of a Skill Reference: how a message names a skill. A message is
 * plain text, and `$name` in it names a library skill, `$<checkout>:<name>`
 * a Repository Skill.
 *
 * The desktop composer, the desktop transcript and the runner's harness
 * adapters all find these tokens with this module, so they cannot disagree
 * about what counts as one. The module only finds tokens. Whether a token names
 * a skill of a session is for the caller to decide, against that session's
 * skill list.
 */

/** One `$name` token found in a text. */
export interface SkillReference {
  /** The name without the `$`, e.g. `review` or `webshop:release-checklist`. */
  readonly name: string;
  /** The index of the `$` in the text. */
  readonly start: number;
  /** The index just past the last character of the name. */
  readonly end: number;
}

/** A stretch of a text, from `start` up to but not including `end`. */
interface TextRange {
  readonly start: number;
  readonly end: number;
}

/**
 * A `$`, then a name that starts with an ASCII letter and continues with
 * letters, digits, `-` and `:`. The `$` counts only at the start of the text or
 * right after whitespace, so `x$foo` and `$foo$bar`'s second `$` are not
 * tokens. The pattern can match a trailing `:` or `-`; `findSkillReferences`
 * removes them.
 */
const TOKEN_PATTERN = /(?<!\S)\$([A-Za-z][A-Za-z0-9:-]*)/g;

/** The characters a name may be made of, once it has started with a letter. */
const NAME_PREFIX_PATTERN = /^(?:[A-Za-z][A-Za-z0-9:-]*)?$/;

/** A line that opens or closes a code fence: up to 3 spaces, then 3 or more backticks or tildes. */
const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Finds every Skill Reference in a text, in the order they appear. Returns an
 * empty array when there is none.
 *
 * A name starts with an ASCII letter and continues with letters, digits, `-`
 * and `:`. A trailing `:` or `-` is text, not part of the name: in
 * `run $review: now` the token is `$review`. A token counts only at the start
 * of the text or right after whitespace, and never inside Markdown code: an
 * inline code span, or a fenced code block. An unmatched backtick run is plain
 * text, and an unclosed fence runs to the end of the text.
 *
 * Known limit: an indented (4 spaces) code block is not detected as code.
 */
export function findSkillReferences(text: string): ReadonlyArray<SkillReference> {
  const codeRanges = findCodeRanges(text);
  const references: SkillReference[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = match.index;
    if (codeRanges.some((range) => start >= range.start && start < range.end)) continue;
    const name = match[1]!.replace(/[:-]+$/, "");
    references.push({ name, start, end: start + 1 + name.length });
  }
  return references;
}

/**
 * Checks whether the text typed right after a `$` can still grow into a Skill
 * Reference. Returns true for `""`, `re` and `webshop:`, and false for `2` and
 * `re view`.
 */
export function isSkillReferencePrefix(typed: string): boolean {
  return NAME_PREFIX_PATTERN.test(typed);
}

/**
 * Finds the stretches of a text that are Markdown code: fenced code blocks and,
 * in the text between them, inline code spans. Returns the ranges in text order.
 *
 * Inline spans are searched between fences only, because a fence line ends the
 * paragraph it follows, so a span never reaches across one.
 */
function findCodeRanges(text: string): ReadonlyArray<TextRange> {
  const ranges: TextRange[] = [];
  let proseStart = 0;
  let openFence: { readonly marker: string; readonly start: number } | undefined;

  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const fence = FENCE_LINE_PATTERN.exec(text.slice(lineStart, lineEnd));

    if (openFence === undefined) {
      // A backtick fence cannot have a backtick in its info string: "```x``` y" is an inline span.
      if (fence !== null && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) {
        ranges.push(...findInlineCodeSpans(text, proseStart, lineStart));
        openFence = { marker: fence[1]!, start: lineStart };
      }
    } else if (
      fence !== null &&
      fence[1]![0] === openFence.marker[0] &&
      fence[1]!.length >= openFence.marker.length &&
      fence[2]!.trim() === ""
    ) {
      ranges.push({ start: openFence.start, end: lineEnd });
      openFence = undefined;
      proseStart = lineEnd;
    }
    lineStart = lineEnd + 1;
  }

  if (openFence === undefined) {
    ranges.push(...findInlineCodeSpans(text, proseStart, text.length));
  } else {
    ranges.push({ start: openFence.start, end: text.length });
  }
  return ranges;
}

/**
 * Finds the inline code spans in `text` between `from` and `to`. Follows
 * CommonMark: a run of N backticks opens a span that closes at the next run of
 * exactly N backticks, and a run with no such partner is plain text. The range
 * of a span includes both backtick runs.
 */
function findInlineCodeSpans(text: string, from: number, to: number): ReadonlyArray<TextRange> {
  const runs = [...text.slice(from, to).matchAll(/`+/g)];
  const spans: TextRange[] = [];
  let opening = 0;
  while (opening < runs.length) {
    const open = runs[opening]!;
    const closing = runs.findIndex(
      (run, index) => index > opening && run[0].length === open[0].length,
    );
    if (closing === -1) {
      opening += 1;
      continue;
    }
    const close = runs[closing]!;
    spans.push({ start: from + open.index, end: from + close.index + close[0].length });
    opening = closing + 1;
  }
  return spans;
}
