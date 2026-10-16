/**
 * Checks the output of `parseMarkdown` for the worst-case inputs of
 * `markdown-worst-case.testing.ts`: no text is lost and the tree has a sensible
 * size. It has no timing check, so it runs in `pnpm test` and in CI, and it is
 * never flaky.
 *
 * The inputs are 200 KB long. A parse that takes linear time takes milliseconds
 * on them. The parses that took quadratic time took 10 seconds and more, and
 * the test runner stops a test that runs longer than the limit below. A load on
 * the machine slows a parse by a small factor, not by a thousand, so the limit
 * stops a slow parse and no busy machine. `markdown.speed.test.ts` measures how
 * fast the parse is, when someone asks for it.
 */
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown";
import type { MarkdownBlock, MarkdownDocument, MarkdownInline } from "./markdown-tree";
import { WORST_CASE_BYTES, WORST_CASE_INPUTS } from "./markdown-worst-case.testing";

/**
 * How long one input may take before the test runner stops the test. A linear
 * parse takes milliseconds, so this is a thousand times the usual time.
 */
const TEST_TIMEOUT_MS = 10_000;

/** The most nodes a tree may hold per character of input. A parse that pads or repeats a node blows past it. */
const MAX_NODES_PER_CHARACTER = 4;

const countInlineNodes = (inlines: ReadonlyArray<MarkdownInline>): number =>
  inlines.reduce(
    (count, inline) =>
      count +
      1 +
      (inline.type === "strong" ||
      inline.type === "emphasis" ||
      inline.type === "strikethrough" ||
      inline.type === "link"
        ? countInlineNodes(inline.children)
        : 0),
    0,
  );

const countBlockNodes = (blocks: ReadonlyArray<MarkdownBlock>): number =>
  blocks.reduce((count, block) => {
    switch (block.type) {
      case "paragraph":
      case "heading":
        return count + 1 + countInlineNodes(block.children);
      case "list":
        return (
          count + 1 + block.items.reduce((sum, item) => sum + countBlockNodes(item.children), 0)
        );
      case "blockquote":
        return count + 1 + countBlockNodes(block.children);
      case "details":
        return count + 1 + countInlineNodes(block.summary) + countBlockNodes(block.children);
      case "table":
        return (
          count +
          1 +
          [block.header, ...block.rows].reduce(
            (sum, row) =>
              sum + row.reduce((cells, cell) => cells + 1 + countInlineNodes(cell.children), 0),
            0,
          )
        );
      case "code":
      case "rule":
        return count + 1;
    }
  }, 0);

const countNodes = (document: MarkdownDocument): number =>
  countBlockNodes(document.blocks) +
  document.footnotes.reduce((count, footnote) => count + countBlockNodes(footnote.children), 0);

const readInlineText = (inlines: ReadonlyArray<MarkdownInline>): string =>
  inlines
    .map((inline) => {
      switch (inline.type) {
        case "text":
        case "inlineCode":
          return inline.text;
        case "image":
          return inline.alt;
        case "strong":
        case "emphasis":
        case "strikethrough":
        case "link":
          return readInlineText(inline.children);
        case "break":
        case "checkbox":
        case "footnoteReference":
        case "footnoteBackReference":
          return "";
      }
    })
    .join("");

const readBlockText = (blocks: ReadonlyArray<MarkdownBlock>): string =>
  blocks
    .map((block) => {
      switch (block.type) {
        case "paragraph":
        case "heading":
          return readInlineText(block.children);
        case "list":
          return block.items.map((item) => readBlockText(item.children)).join("");
        case "blockquote":
          return readBlockText(block.children);
        case "details":
          return readInlineText(block.summary) + readBlockText(block.children);
        case "table":
          return [block.header, ...block.rows]
            .map((row) => row.map((cell) => readInlineText(cell.children)).join(""))
            .join("");
        case "code":
          return block.text;
        case "rule":
          return "";
      }
    })
    .join("");

/** Returns the text that a document shows, in order, without white space. */
const readShownText = (document: MarkdownDocument): string =>
  (
    readBlockText(document.blocks) +
    document.footnotes.map((footnote) => readBlockText(footnote.children)).join("")
  ).replace(/\s+/g, "");

describe("parseMarkdown worst-case input", () => {
  it.each(WORST_CASE_INPUTS)(
    "keeps the text and a sensible size for $name",
    ({ text, shownText }) => {
      const document = parseMarkdown(text);

      if (shownText !== undefined) expect(readShownText(document)).toBe(shownText);
      expect(countNodes(document)).toBeLessThan(MAX_NODES_PER_CHARACTER * WORST_CASE_BYTES);
    },
    TEST_TIMEOUT_MS,
  );
});
