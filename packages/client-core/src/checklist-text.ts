/**
 * Reads the Markdown of a setup `checklist` step into the little a setup form
 * draws: paragraphs, lists, emphasis, code, and links to `http` and `https`
 * addresses. A plugin writes that Markdown, so the form must not give it more
 * than that: no embedded HTML, no image that loads when the form opens (an
 * image shows as its alternative text), and no link to anything but a web
 * address.
 */
import { parseMarkdown } from "./markdown";
import type { MarkdownBlock, MarkdownInline } from "./markdown-tree";

/** One run of text in a checklist: plain, emphasised, code or a link to a web address. */
export type ChecklistInline =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "strong" | "emphasis"; readonly children: ReadonlyArray<ChecklistInline> }
  | { readonly type: "code"; readonly text: string }
  | {
      readonly type: "link";
      readonly href: string;
      readonly children: ReadonlyArray<ChecklistInline>;
    };

/** A paragraph, or a list whose items hold blocks of their own. */
export type ChecklistBlock =
  | { readonly type: "paragraph"; readonly children: ReadonlyArray<ChecklistInline> }
  | {
      readonly type: "list";
      /** The first item's number, or undefined in a bulleted list. */
      readonly start: number | undefined;
      readonly items: ReadonlyArray<ReadonlyArray<ChecklistBlock>>;
    };

/** Checks that `href` is an absolute `http` or `https` address, the only kind a checklist links to. */
const isWebAddress = (href: string): boolean => {
  const url = URL.parse(href);
  return url !== null && (url.protocol === "http:" || url.protocol === "https:");
};

/**
 * Converts parsed inlines to checklist inlines. A link whose address is not a
 * web address keeps its text and loses the link. An image becomes its
 * alternative text. A footnote mark, a skill reference and a task box are
 * dropped, and a line break becomes a newline.
 */
const readInlines = (inlines: ReadonlyArray<MarkdownInline>): ChecklistInline[] =>
  inlines.flatMap((inline): ChecklistInline[] => {
    switch (inline.type) {
      case "text":
        return [{ type: "text", text: inline.text }];
      case "strong":
      case "emphasis":
        return [{ type: inline.type, children: readInlines(inline.children) }];
      case "strikethrough":
        return readInlines(inline.children);
      case "inlineCode":
        return [{ type: "code", text: inline.text }];
      case "break":
        return [{ type: "text", text: "\n" }];
      case "link":
        return isWebAddress(inline.href)
          ? [{ type: "link", href: inline.href, children: readInlines(inline.children) }]
          : readInlines(inline.children);
      case "image":
        return inline.alt === "" ? [] : [{ type: "text", text: inline.alt }];
      case "skill":
      case "checkbox":
      case "footnoteReference":
      case "footnoteBackReference":
        return [];
    }
  });

/** Converts parsed blocks to checklist blocks: a heading, a code block or a quote reads as paragraphs, a rule and a table's cells as text. */
const readBlocks = (blocks: ReadonlyArray<MarkdownBlock>): ChecklistBlock[] =>
  blocks.flatMap((block): ChecklistBlock[] => {
    switch (block.type) {
      case "paragraph":
      case "heading":
        return [{ type: "paragraph", children: readInlines(block.children) }];
      case "list":
        return [
          {
            type: "list",
            start: block.start,
            items: block.items.map((item) => readBlocks(item.children)),
          },
        ];
      case "blockquote":
        return readBlocks(block.children);
      case "code":
        return [{ type: "paragraph", children: [{ type: "text", text: block.text }] }];
      case "table":
        return [...block.header, ...block.rows.flat()].map((cell) => ({
          type: "paragraph",
          children: readInlines(cell.children),
        }));
      case "rule":
        return [];
      case "details":
        return [
          { type: "paragraph", children: readInlines(block.summary) },
          ...readBlocks(block.children),
        ];
    }
  });

/**
 * Returns the blocks of a checklist step's Markdown. Embedded HTML is not
 * read, so a tag shows as the characters written. Text that cannot be parsed
 * (it nests deeper than the parser allows) is returned as one paragraph of
 * the text as written.
 */
export const readChecklist = (markdown: string): ChecklistBlock[] => {
  try {
    return readBlocks(parseMarkdown(markdown, { embeddedHtml: false }).blocks);
  } catch {
    return [{ type: "paragraph", children: [{ type: "text", text: markdown }] }];
  }
};
