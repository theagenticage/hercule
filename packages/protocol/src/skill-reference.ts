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
 * knows fenced code blocks, indented code blocks and inline code spans, block
 * quotes and list items around them, and the blocks that end a paragraph
 * (headings, thematic breaks). The scan is linear in the length of the text,
 * because the desktop composer runs it after every edit.
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

/** A name as `TOKEN_PATTERN` reads it, at the index set in `lastIndex`. */
const NAME_AT_INDEX_PATTERN = /[A-Za-z0-9][A-Za-z0-9:-]*/y;

/** One character of a name after its first, spelled as in `TOKEN_PATTERN`. */
const NAME_CHARACTER_PATTERN = /^[A-Za-z0-9:-]$/;

/** The characters a name may be made of, once it has started. */
const NAME_PREFIX_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9:-]*)?$/;

/** A line ending: CRLF, a lone CR, or a lone LF. */
const LINE_ENDING_PATTERN = /\r\n?|\n/g;

/** An ATX heading line (`# Title`) that has no leading spaces or tabs. */
const HEADING_PATTERN = /^#{1,6}(?: |$)/;

/** The marker of a block quote line: up to 3 spaces, `>`, and one optional space. */
const QUOTE_MARKER_PATTERN = / {0,3}> ?/y;

/**
 * The start of a container on a line: up to 3 spaces, then either a `>` with
 * an optional space (group 1 is undefined), or a list marker (`-`, `+`, `*`,
 * `1.` or `1)`) that is followed by a space or the end of the line, and those
 * spaces (group 2).
 */
const CONTAINER_START_PATTERN = / {0,3}(?:> ?|([-+*]|\d{1,9}[.)])(?=[ ]|$)( *))/y;

/**
 * Containers nested deeper than this are not tracked. Tracking costs time per
 * line for every container, so the limit keeps the scan linear. In 10 nested
 * containers a code fence is therefore not seen, which no real message has.
 */
const MAX_CONTAINERS = 10;

/** How many columns a tab advances to: the next multiple of this. */
const TAB_COLUMNS = 4;

/** An indent of this many columns, outside a paragraph, makes a line indented code. */
const INDENTED_CODE_COLUMNS = 4;

/** The most spaces a fence, heading or thematic break may be indented by. */
const MAX_BLOCK_INDENT = 3;

/**
 * A block that holds lines of a text: Markdown code, or one paragraph or
 * heading of prose that may hold inline code spans. An inline code span never
 * reaches outside its block.
 */
interface Block {
  readonly kind: "code" | "prose";
  readonly start: number;
  end: number;
}

/**
 * A block quote or a list item that a line sits in. A list item continues on
 * the lines that are indented by at least `indent` columns, counted from the
 * start of its parent's content. An item that starts with no content (`-` alone
 * on its line) has `hasContent` false until a line with content continues it,
 * and a blank line ends it while it is still empty.
 */
type Container =
  | { readonly kind: "quote" }
  | { readonly kind: "list"; readonly indent: number; hasContent: boolean };

/** A run of backticks or tildes that can open or close a code fence. */
interface FenceRun {
  readonly character: string;
  readonly length: number;
  /** The index in the line just past the run. */
  readonly end: number;
}

/** An open code fence: its opening run, and the containers it sits in. */
interface OpenFence {
  readonly run: FenceRun;
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
 * - an inline code span, which does not reach across the end of its paragraph
 *   (a blank line, a heading, a thematic break, or the start of a block quote
 *   or list item), and which a backslash before its opening backticks prevents
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
    const name = validateSkillName(match[1]!);
    if (name === undefined) continue;
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

/** Checks whether `character` is a single character that a skill name may contain. */
export function isSkillNameCharacter(character: string): boolean {
  return NAME_CHARACTER_PATTERN.test(character);
}

/**
 * Reads the name of a Skill Reference that starts at index `from` of `text`,
 * the index just after a `$`. Returns the name as `findSkillReferences` reports
 * it: without a trailing `:` or `-`, and only when every part of it holds a
 * letter. Returns undefined when no valid name starts there. It does not look
 * at what comes before `from`.
 */
export function readSkillReferenceName(text: string, from: number): string | undefined {
  NAME_AT_INDEX_PATTERN.lastIndex = from;
  const match = NAME_AT_INDEX_PATTERN.exec(text);
  return match === null ? undefined : validateSkillName(match[0]);
}

/**
 * Returns the name of a Skill Reference read from a run of name characters:
 * `token` without the `:` and `-` characters at its end. Returns undefined when
 * a part of the name, between its `:`, holds no letter, as in `$20`.
 */
function validateSkillName(token: string): string | undefined {
  const name = trimTrailingSeparators(token);
  return name.split(":").every((part) => /[A-Za-z]/.test(part)) ? name : undefined;
}

/**
 * Returns `name` without the `:` and `-` characters at its end. Scans from the
 * end, so the cost is linear even for a name full of `-` in the middle.
 */
function trimTrailingSeparators(name: string): string {
  let end = name.length;
  while (end > 0 && (name[end - 1] === ":" || name[end - 1] === "-")) end -= 1;
  return name.slice(0, end);
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
 * - A paragraph ends at a blank line, a fence, an indented code line, a
 *   heading, a thematic break, a setext underline, or the start of a block
 *   quote or list item. An inline code span never reaches across the end of a
 *   paragraph.
 */
function findCodeRanges(text: string): ReadonlyArray<TextRange> {
  const blocks: Block[] = [];
  // The prose block of the paragraph that the previous line belongs to, if it belongs to one.
  let paragraph: Block | undefined;
  // The code block that the previous line belongs to, if it belongs to one.
  let code: Block | undefined;
  const isInParagraph = () => paragraph !== undefined;
  const startBlock = (kind: Block["kind"], line: TextRange): Block => {
    const block = { kind, start: line.start, end: line.end };
    blocks.push(block);
    return block;
  };
  const endBlocks = () => {
    paragraph = undefined;
    code = undefined;
  };
  const addCodeLine = (line: TextRange) => {
    paragraph = undefined;
    if (code === undefined) code = startBlock("code", line);
    else code.end = line.end;
  };
  const addParagraphLine = (line: TextRange) => {
    code = undefined;
    if (paragraph === undefined) paragraph = startBlock("prose", line);
    else paragraph.end = line.end;
  };
  const addHeadingLine = (line: TextRange) => {
    endBlocks();
    startBlock("prose", line);
  };

  let containers: Container[] = [];
  let fence: OpenFence | undefined;

  for (const range of readLines(text)) {
    const line = expandTabs(text.slice(range.start, range.end));

    if (fence !== undefined) {
      const continued = continueContainers(line, fence.containers);
      if (continued.matched === fence.containers.length) {
        addCodeLine(range);
        if (closesFence(line, continued.pos, fence.run)) {
          containers = [...fence.containers];
          fence = undefined;
        }
        continue;
      }
      // The container that held the fence ended, so the fence did too. This line is ordinary text.
      containers = fence.containers.slice(0, continued.matched);
      fence = undefined;
      endBlocks();
    }

    const continued = continueContainers(line, containers);
    const isLazy = continued.matched < containers.length;
    const previousContainers = containers;
    containers = containers.slice(0, continued.matched);
    // A setext underline ends the paragraph above it. It is checked before containers open
    // because a lone `-` would otherwise read as an empty list item.
    if (isInParagraph() && !isLazy && isSetextUnderline(line.slice(continued.pos))) {
      endBlocks();
      continue;
    }
    const wasInParagraph = isInParagraph();
    const opened = openContainers(line, continued.pos, containers, wasInParagraph && !isLazy);
    const rest = line.slice(opened.pos);
    if (opened.added) endBlocks();

    if (isBlankFrom(rest, 0)) {
      endBlocks();
    } else if (!isInParagraph() && countIndent(rest) >= INDENTED_CODE_COLUMNS) {
      addCodeLine(range);
    } else {
      const opening = readFenceOpening(rest);
      if (opening !== undefined) {
        addCodeLine(range);
        fence = { run: opening, containers: [...containers] };
      } else if (isThematicBreak(rest)) {
        endBlocks();
      } else if (HEADING_PATTERN.test(rest.slice(skipIndent(rest)))) {
        addHeadingLine(range);
      } else {
        addParagraphLine(range);
        // A line that does not continue its containers still belongs to the open paragraph when it
        // is plain text (lazy continuation), so the quote or list item stays open around it.
        if (isLazy && !opened.added && wasInParagraph) containers = previousContainers;
      }
    }
  }

  const ranges: TextRange[] = [];
  for (const block of blocks) {
    if (block.kind === "code") ranges.push(block);
    else findInlineCodeSpans(text, block.start, block.end, ranges);
  }
  return ranges;
}

/**
 * Yields the lines of `text` as ranges that exclude the line ending. A line
 * ends at CRLF, a lone CR or a lone LF, as in CommonMark. A text that ends in a
 * line ending has an empty last line.
 */
function* readLines(text: string): Generator<TextRange> {
  let start = 0;
  for (;;) {
    LINE_ENDING_PATTERN.lastIndex = start;
    const ending = LINE_ENDING_PATTERN.exec(text);
    if (ending === null) {
      yield { start, end: text.length };
      return;
    }
    yield { start, end: ending.index };
    start = ending.index + ending[0].length;
  }
}

/**
 * Returns `line` with each tab replaced by the spaces that reach the next tab
 * stop, as CommonMark counts a tab. After this a column is a character, so a
 * tab behind a `>` or a list marker needs no special case.
 */
function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let expanded = "";
  for (const character of line) {
    expanded +=
      character === "\t" ? " ".repeat(TAB_COLUMNS - (expanded.length % TAB_COLUMNS)) : character;
  }
  return expanded;
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
    } else if (isBlankFrom(line, pos)) {
      if (!container.hasContent) break;
    } else {
      if (!hasSpaces(line, pos, container.indent)) break;
      pos += container.indent;
      container.hasContent = true;
    }
    matched += 1;
  }
  return { matched, pos };
}

/**
 * Adds to `containers` the block quotes and list items that start on `line`
 * at index `from`. Returns the index where the content of the line starts, and
 * whether it added any container. At most `MAX_CONTAINERS` are kept. A line
 * that is a thematic break (`- - -`) starts no list item. `inParagraph` tells
 * whether a paragraph is open, which some list items cannot interrupt.
 */
function openContainers(
  line: string,
  from: number,
  containers: Container[],
  inParagraph: boolean,
): { readonly pos: number; readonly added: boolean } {
  let pos = from;
  let added = false;
  while (containers.length < MAX_CONTAINERS) {
    if (isThematicBreak(line.slice(pos))) break;
    CONTAINER_START_PATTERN.lastIndex = pos;
    const match = CONTAINER_START_PATTERN.exec(line);
    if (match === null) break;
    const afterSpaces = CONTAINER_START_PATTERN.lastIndex;
    const marker = match[1];
    // A list item cannot interrupt a paragraph when it is empty or when it is numbered from a
    // number other than 1, so such a line is a continuation of the paragraph. (The caller passes
    // `inParagraph` false for a lazy line: that line is not inside the paragraph's containers,
    // so it is a new block there.)
    if (
      inParagraph &&
      !added &&
      marker !== undefined &&
      (afterSpaces === line.length || (/\d/.test(marker) && Number.parseInt(marker, 10) !== 1))
    ) {
      break;
    }
    added = true;
    if (marker === undefined) {
      containers.push({ kind: "quote" });
      pos = afterSpaces;
      continue;
    }
    const spaces = match[2]!.length;
    const leading = afterSpaces - pos - marker.length - spaces;
    if (spaces > INDENTED_CODE_COLUMNS || afterSpaces === line.length) {
      // An empty item, or an item that starts with an indented code block: the content starts
      // one column after the marker, and any further spaces belong to the content.
      containers.push({
        kind: "list",
        indent: leading + marker.length + 1,
        hasContent: afterSpaces !== line.length,
      });
      pos = afterSpaces === line.length ? afterSpaces : afterSpaces - spaces + 1;
    } else {
      containers.push({ kind: "list", indent: leading + marker.length + spaces, hasContent: true });
      pos = afterSpaces;
    }
  }
  return { pos, added };
}

/**
 * Returns the index in `line` after its leading spaces, at most 3 of them.
 * Fences, headings and thematic breaks may be indented that far and no
 * further.
 */
function skipIndent(line: string): number {
  let pos = 0;
  while (pos < MAX_BLOCK_INDENT && line[pos] === " ") pos += 1;
  return pos;
}

/** Returns the number of spaces that start `line`. */
function countIndent(line: string): number {
  let count = 0;
  while (line[count] === " ") count += 1;
  return count;
}

/**
 * Reads a run of 3 or more backticks or tildes at the start of `line`, after at
 * most 3 spaces. Returns `undefined` when `line` has none.
 */
function readFenceRun(line: string, from = 0): FenceRun | undefined {
  const start = from + skipIndent(line.slice(from));
  const character = line[start];
  if (character !== "`" && character !== "~") return undefined;
  let end = start;
  while (line[end] === character) end += 1;
  return end - start >= 3 ? { character, length: end - start, end } : undefined;
}

/** Returns the fence run that `line` opens, or `undefined` when it opens none. */
function readFenceOpening(line: string): FenceRun | undefined {
  const run = readFenceRun(line);
  if (run === undefined) return undefined;
  // A backtick fence has no backtick in its info string: "```x``` y" is an inline span.
  if (run.character === "`" && line.indexOf("`", run.end) !== -1) return undefined;
  return run;
}

/**
 * Checks whether `line`, from index `from`, closes the fence that `opening`
 * opened: a run of the same character, at least as long, with nothing after it.
 */
function closesFence(line: string, from: number, opening: FenceRun): boolean {
  const run = readFenceRun(line, from);
  return (
    run !== undefined &&
    run.character === opening.character &&
    run.length >= opening.length &&
    isBlankFrom(line, run.end)
  );
}

/**
 * Checks whether `line` is a thematic break: 3 or more `-`, `_` or `*` of one
 * kind, with only spaces between them, after at most 3 spaces.
 */
function isThematicBreak(line: string): boolean {
  let pos = skipIndent(line);
  const character = line[pos];
  if (character !== "-" && character !== "_" && character !== "*") return false;
  let count = 0;
  for (; pos < line.length; pos += 1) {
    if (line[pos] === character) count += 1;
    else if (line[pos] !== " ") return false;
  }
  return count >= 3;
}

/**
 * Checks whether `line` is a setext heading underline: a run of `=` or a run of
 * `-`, after at most 3 spaces and before nothing but spaces. It only counts as
 * one below a paragraph line.
 */
function isSetextUnderline(line: string): boolean {
  let pos = skipIndent(line);
  const character = line[pos];
  if (character !== "=" && character !== "-") return false;
  while (line[pos] === character) pos += 1;
  return isBlankFrom(line, pos);
}

/** Checks whether `line` has `count` spaces from index `from`. */
function hasSpaces(line: string, from: number, count: number): boolean {
  for (let pos = from; pos < from + count; pos += 1) {
    if (line[pos] !== " ") return false;
  }
  return true;
}

/** Checks whether `line` has only spaces from index `from` to its end. */
function isBlankFrom(line: string, from: number): boolean {
  for (let pos = from; pos < line.length; pos += 1) {
    if (line[pos] !== " ") return false;
  }
  return true;
}

/** One run of backticks in a paragraph. */
interface BacktickRun {
  /** The index in the text of the first backtick. */
  readonly start: number;
  readonly length: number;
  /** True when an odd number of backslashes come right before the run. */
  readonly isEscaped: boolean;
}

/**
 * Finds the inline code spans in `text` between `from` and `to`, and appends
 * them to `ranges`. Follows CommonMark: a run of N backticks opens a span that
 * closes at the next run of exactly N backticks, and a run with no such partner
 * is plain text. The range of a span includes both backtick runs.
 *
 * A backslash before a run makes its first backtick literal, so the run opens
 * a span as one backtick shorter (and not at all when it was a single
 * backtick). Inside a span a backslash is literal, so a run that closes a span
 * closes it with all its backticks.
 *
 * The search stays inside `from` and `to`. Each opening run looks up its partner in the list of runs of the length it
 * needs, with a cursor that only moves forward, so the cost is linear in the
 * number of runs.
 */
function findInlineCodeSpans(text: string, from: number, to: number, ranges: TextRange[]): void {
  // Searches the block only: a search that runs on into the rest of the text makes a text of
  // many small blocks quadratic.
  const block = text.slice(from, to);
  if (!block.includes("`")) return;

  const runs: BacktickRun[] = [];
  const runsByLength = new Map<number, number[]>();
  for (const match of block.matchAll(/`+/g)) {
    const start = from + match.index;
    let backslashes = 0;
    while (start - backslashes > from && text[start - backslashes - 1] === "\\") backslashes += 1;
    const length = match[0].length;
    const indices = runsByLength.get(length) ?? [];
    indices.push(runs.length);
    runsByLength.set(length, indices);
    runs.push({ start, length, isEscaped: backslashes % 2 === 1 });
  }

  const cursors = new Map<number, number>();
  let opening = 0;
  while (opening < runs.length) {
    const open = runs[opening]!;
    const openLength = open.isEscaped ? open.length - 1 : open.length;
    const candidates = runsByLength.get(openLength);
    if (candidates === undefined) {
      opening += 1;
      continue;
    }
    let cursor = cursors.get(openLength) ?? 0;
    while (cursor < candidates.length && candidates[cursor]! <= opening) cursor += 1;
    cursors.set(openLength, cursor);
    const closing = candidates[cursor];
    if (closing === undefined) {
      opening += 1;
      continue;
    }
    const close = runs[closing]!;
    ranges.push({ start: open.start + (open.isEscaped ? 1 : 0), end: close.start + close.length });
    opening = closing + 1;
  }
}
