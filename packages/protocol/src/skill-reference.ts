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
 *
 * A token inside Markdown code is text, because the transcript draws that code
 * as code. The module finds code with a line scan, not a Markdown parser: it
 * knows fenced code blocks, indented code blocks and inline code spans, and
 * block quotes and list items around them.
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
 * A `$`, then a name that starts with an ASCII letter or digit and continues
 * with letters, digits, `-` and `:`. The `$` counts only at the start of the
 * text or right after whitespace, so `x$foo` and `$foo$bar`'s second `$` are
 * not tokens. The pattern also matches `$20` and a trailing `:` or `-`;
 * `findSkillReferences` removes the trailing ones and rejects names without a
 * letter.
 */
const TOKEN_PATTERN = /(?<!\S)\$([A-Za-z0-9][A-Za-z0-9:-]*)/g;

/** The characters a name may be made of, once it has started. */
const NAME_PREFIX_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9:-]*)?$/;

/** A line that opens or closes a code fence: up to 3 spaces, then 3 or more backticks or tildes. */
const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** An ATX heading line (`# Title`), which a following indented line is not a continuation of. */
const HEADING_PATTERN = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/** The marker of a block quote line: up to 3 spaces, `>`, and one optional space. */
const QUOTE_MARKER_PATTERN = / {0,3}> ?/y;

/** The rest of a line is blank: only spaces and tabs up to the end. */
const BLANK_REST_PATTERN = /[ \t]*$/y;

/**
 * The start of a container on a line: up to 3 spaces, then either a `>` with
 * an optional space (group 2 is undefined), or a list marker (`-`, `+`, `*`,
 * `1.` or `1)`) that is followed by whitespace or the end of the line, and that
 * whitespace (group 3).
 */
const CONTAINER_START_PATTERN = / {0,3}(?:> ?|([-+*]|\d{1,9}[.)])(?=[ \t]|$)([ \t]*))/y;

/**
 * Containers nested deeper than this are not tracked. Tracking costs time per
 * line for every container, so the limit keeps the scan linear. In 10 nested
 * containers a code fence is therefore not seen, which no real message has.
 */
const MAX_CONTAINERS = 10;

/** How many columns a tab counts for. */
const TAB_COLUMNS = 4;

/** An indent of this many columns, outside a paragraph, makes a line indented code. */
const INDENTED_CODE_COLUMNS = 4;

/** A block that holds a line of a text: Markdown code, or prose that may hold inline code. */
interface Block {
  readonly kind: "code" | "prose";
  readonly start: number;
  end: number;
}

/**
 * A block quote or a list item that a line sits in. A list item continues on
 * the lines that are indented by at least `indent` columns, counted from the
 * start of its parent's content.
 */
type Container = { readonly kind: "quote" } | { readonly kind: "list"; readonly indent: number };

/** An open code fence: the character and length of its opening run, and the containers it sits in. */
interface OpenFence {
  readonly marker: string;
  readonly containers: ReadonlyArray<Container>;
}

/**
 * Finds every Skill Reference in a text, in the order they appear. Returns an
 * empty array when there is none.
 *
 * A name starts with an ASCII letter or digit and continues with letters,
 * digits, `-` and `:`. Each part of the name (the checkout and the skill, which
 * `:` separates) holds at least one letter, so `$3d-modeling` and `$3d:release`
 * are references and `$20`, `$1.50` and `$2024` are text. A trailing `:` or `-`
 * is text, not part of the name: in `run $review: now` the token is `$review`.
 * A token counts only at the start of the text or right after whitespace, and
 * never inside Markdown code:
 *
 * - an inline code span, which does not reach across a blank line
 * - a fenced code block, also inside a block quote or a list item
 * - an indented code block, also inside a block quote or a list item
 *
 * An unmatched backtick run is plain text, and an unclosed fence runs to the
 * end of the text, or to the end of the container it sits in.
 */
export function findSkillReferences(text: string): ReadonlyArray<SkillReference> {
  const codeRanges = findCodeRanges(text);
  const references: SkillReference[] = [];
  // Tokens and code ranges are both in text order, so one cursor walks the ranges.
  let nextRange = 0;
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = match.index;
    while (nextRange < codeRanges.length && codeRanges[nextRange]!.end <= start) nextRange += 1;
    if (nextRange < codeRanges.length && codeRanges[nextRange]!.start <= start) continue;
    const name = match[1]!.replace(/[:-]+$/, "");
    if (!name.split(":").every((part) => /[A-Za-z]/.test(part))) continue;
    references.push({ name, start, end: start + 1 + name.length });
  }
  return references;
}

/**
 * Returns the text with a backslash in front of the `$` of each Skill
 * Reference in it, so `$review` becomes `\$review`. With `shouldEscape`, only
 * the references it accepts are escaped. Text with no reference to escape is
 * returned unchanged.
 *
 * This is for text that came from somewhere other than the person who sends
 * the input, such as a value a workflow template inserts into a prompt: the
 * text then cannot make the runner start a skill. A `$` after a backslash does
 * not follow whitespace, so `findSkillReferences` finds nothing in the result
 * when every reference is escaped.
 *
 * Adding a backslash cannot create a reference or hide code: it adds no `$`,
 * no whitespace, and nothing that opens or closes Markdown code. So the
 * references that remain are exactly the ones `shouldEscape` refused. The
 * transcript draws `\$review` as the text `$review`. Only references are
 * escaped, so `$20` and a `$review` inside code keep their text.
 *
 * Codex scans a message for `$name` itself, so the backslash does not stop
 * Codex from starting a skill (spec 06 section 9.4).
 */
export function escapeSkillReferences(
  text: string,
  shouldEscape: (reference: SkillReference) => boolean = () => true,
): string {
  let escaped = "";
  let from = 0;
  for (const reference of findSkillReferences(text)) {
    if (!shouldEscape(reference)) continue;
    escaped += `${text.slice(from, reference.start)}\\`;
    from = reference.start;
  }
  return escaped + text.slice(from);
}

/**
 * Checks whether the text typed right after a `$` can still grow into a Skill
 * Reference. Returns true for `""`, `re`, `3d` and `webshop:`, and false for
 * `-` and `re view`. It does not look for a letter: `20` can still grow into
 * `20d`.
 */
export function isSkillReferencePrefix(typed: string): boolean {
  return NAME_PREFIX_PATTERN.test(typed);
}

/**
 * Finds the stretches of a text that are Markdown code: fenced code blocks,
 * indented code blocks and, in the paragraphs between them, inline code spans.
 * Returns the ranges in text order, without overlap.
 *
 * Reads the text one line at a time and follows the CommonMark rules that
 * matter for code:
 *
 * - A fence line opens a fence. A closing line uses the same character, at
 *   least as many of them, and has no info string.
 * - A line indented by 4 columns is code, unless it continues a paragraph.
 * - A fence belongs to the block quotes and list items it sits in, and it ends
 *   with the first one that does not continue.
 * - A blank line, a fence or an indented code line ends a paragraph, and an
 *   inline code span never reaches across the end of a paragraph.
 */
function findCodeRanges(text: string): ReadonlyArray<TextRange> {
  const blocks: Block[] = [];
  let current: Block | undefined;
  const extendBlock = (kind: Block["kind"], start: number, end: number) => {
    if (current?.kind === kind) {
      current.end = end;
    } else {
      current = { kind, start, end };
      blocks.push(current);
    }
  };

  let containers: Container[] = [];
  let fence: OpenFence | undefined;
  // True while the previous line was text that an indented line would continue.
  let inParagraph = false;

  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    const nextLineStart = lineEnd + 1;

    if (fence !== undefined) {
      const continued = continueContainers(line, fence.containers);
      if (continued.matched === fence.containers.length) {
        extendBlock("code", lineStart, lineEnd);
        if (closesFence(line.slice(continued.pos), fence.marker)) {
          containers = [...fence.containers];
          fence = undefined;
          inParagraph = false;
        }
        lineStart = nextLineStart;
        continue;
      }
      // The container that held the fence ended, so the fence did too. This line is ordinary text.
      containers = fence.containers.slice(0, continued.matched);
      fence = undefined;
      inParagraph = false;
    }

    const continued = continueContainers(line, containers);
    containers = containers.slice(0, continued.matched);
    const opened = openContainers(line, continued.pos, containers);
    const rest = line.slice(opened.pos);
    if (opened.added) inParagraph = false;

    if (rest.trim() === "") {
      current = undefined;
      inParagraph = false;
    } else if (!inParagraph && countColumns(readIndent(rest)) >= INDENTED_CODE_COLUMNS) {
      extendBlock("code", lineStart, lineEnd);
    } else {
      const opening = readFenceOpening(rest);
      if (opening === undefined) {
        extendBlock("prose", lineStart, lineEnd);
        inParagraph = !HEADING_PATTERN.test(rest);
      } else {
        extendBlock("code", lineStart, lineEnd);
        fence = { marker: opening, containers: [...containers] };
        inParagraph = false;
      }
    }
    lineStart = nextLineStart;
  }

  const ranges: TextRange[] = [];
  for (const block of blocks) {
    if (block.kind === "code") ranges.push(block);
    else findInlineCodeSpans(text, block.start, block.end, ranges);
  }
  return ranges;
}

/**
 * Returns how many of `containers` continue on `line`, and the index in `line`
 * where their content starts. A block quote continues with a `>` marker. A list
 * item continues with an indent of its width, or with a blank line.
 */
function continueContainers(
  line: string,
  containers: ReadonlyArray<Container>,
): { readonly matched: number; readonly pos: number } {
  let pos = 0;
  let matched = 0;
  for (const container of containers) {
    if (container.kind === "quote") {
      QUOTE_MARKER_PATTERN.lastIndex = pos;
      if (!QUOTE_MARKER_PATTERN.test(line)) break;
      pos = QUOTE_MARKER_PATTERN.lastIndex;
    } else {
      if (!isBlankFrom(line, pos)) {
        const next = skipColumns(line, pos, container.indent);
        if (next === -1) break;
        pos = next;
      }
    }
    matched += 1;
  }
  return { matched, pos };
}

/**
 * Adds to `containers` the block quotes and list items that start on `line`
 * at index `from`. Returns the index where the content of the line starts, and
 * whether it added any container. At most `MAX_CONTAINERS` are kept.
 */
function openContainers(
  line: string,
  from: number,
  containers: Container[],
): { readonly pos: number; readonly added: boolean } {
  let pos = from;
  let added = false;
  while (containers.length < MAX_CONTAINERS) {
    CONTAINER_START_PATTERN.lastIndex = pos;
    const match = CONTAINER_START_PATTERN.exec(line);
    if (match === null) break;
    added = true;
    const afterWhitespace = CONTAINER_START_PATTERN.lastIndex;
    const marker = match[1];
    if (marker === undefined) {
      containers.push({ kind: "quote" });
      pos = afterWhitespace;
      continue;
    }
    const whitespace = match[2]!;
    const leading = afterWhitespace - pos - marker.length - whitespace.length;
    const columns = countColumns(whitespace);
    if (columns > INDENTED_CODE_COLUMNS || afterWhitespace === line.length) {
      // An empty item, or an item that starts with an indented code block: the content starts
      // one column after the marker, and any further whitespace belongs to the content.
      containers.push({ kind: "list", indent: leading + marker.length + 1 });
      pos =
        afterWhitespace === line.length ? afterWhitespace : afterWhitespace - whitespace.length + 1;
    } else {
      containers.push({ kind: "list", indent: leading + marker.length + columns });
      pos = afterWhitespace;
    }
  }
  return { pos, added };
}

/** Returns the marker run of a fence that `line` opens, or `undefined` when it opens none. */
function readFenceOpening(line: string): string | undefined {
  const fence = FENCE_LINE_PATTERN.exec(line);
  if (fence === null) return undefined;
  // A backtick fence has no backtick in its info string: "```x``` y" is an inline span.
  if (fence[1]![0] === "`" && fence[2]!.includes("`")) return undefined;
  return fence[1]!;
}

/**
 * Checks whether `line` closes the fence that `marker` opened: a run of the
 * same character, at least as long, with nothing after it.
 */
function closesFence(line: string, marker: string): boolean {
  const fence = FENCE_LINE_PATTERN.exec(line);
  return (
    fence !== null &&
    fence[1]![0] === marker[0] &&
    fence[1]!.length >= marker.length &&
    fence[2]!.trim() === ""
  );
}

/** Returns the spaces and tabs that start `line`. */
function readIndent(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

/** Returns the width in columns of leading whitespace: a space is 1 column and a tab is 4. */
function countColumns(whitespace: string): number {
  let columns = 0;
  for (const character of whitespace) columns += character === "\t" ? TAB_COLUMNS : 1;
  return columns;
}

/**
 * Returns the index in `line` after `columns` columns of whitespace that start
 * at `from`, or -1 when the line has a character that is not whitespace first.
 */
function skipColumns(line: string, from: number, columns: number): number {
  let skipped = 0;
  let pos = from;
  while (skipped < columns) {
    const character = line[pos];
    if (character === " ") skipped += 1;
    else if (character === "\t") skipped += TAB_COLUMNS;
    else return -1;
    pos += 1;
  }
  return pos;
}

/** Checks whether `line` has only spaces and tabs from index `from` to its end. */
function isBlankFrom(line: string, from: number): boolean {
  BLANK_REST_PATTERN.lastIndex = from;
  return BLANK_REST_PATTERN.test(line);
}

/**
 * Finds the inline code spans in `text` between `from` and `to`, and appends
 * them to `ranges`. Follows CommonMark: a run of N backticks opens a span that
 * closes at the next run of exactly N backticks, and a run with no such partner
 * is plain text. The range of a span includes both backtick runs.
 *
 * Each run looks up its partner in a table built from the end, so the cost is
 * linear in the number of runs.
 */
function findInlineCodeSpans(text: string, from: number, to: number, ranges: TextRange[]): void {
  const runs = [...text.slice(from, to).matchAll(/`+/g)];
  const partners: number[] = new Array<number>(runs.length).fill(-1);
  const nextRunOfLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const length = runs[index]![0].length;
    partners[index] = nextRunOfLength.get(length) ?? -1;
    nextRunOfLength.set(length, index);
  }

  let opening = 0;
  while (opening < runs.length) {
    const closing = partners[opening]!;
    if (closing === -1) {
      opening += 1;
      continue;
    }
    const open = runs[opening]!;
    const close = runs[closing]!;
    ranges.push({ start: from + open.index, end: from + close.index + close[0].length });
    opening = closing + 1;
  }
}
