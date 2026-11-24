import { Fragment, type JSX, type ReactNode } from "react";
import { readChecklist, type ChecklistBlock, type ChecklistInline } from "@hercule/client-core";
import { INLINE_CODE } from "../../../screens/markdown";

/** Draws a run of inlines. A link opens a new tab and sends no referrer, as the plugin writes both its text and its target. */
const drawInlines = (inlines: ReadonlyArray<ChecklistInline>): ReactNode =>
  inlines.map((inline, index) => {
    switch (inline.type) {
      case "text":
        return <Fragment key={index}>{inline.text}</Fragment>;
      case "strong":
        return (
          <strong key={index} className="font-emph">
            {drawInlines(inline.children)}
          </strong>
        );
      case "emphasis":
        return <em key={index}>{drawInlines(inline.children)}</em>;
      case "code":
        return (
          <code key={index} className={INLINE_CODE}>
            {inline.text}
          </code>
        );
      case "link":
        return (
          <a
            key={index}
            href={inline.href}
            target="_blank"
            rel="noreferrer"
            className="text-ink underline decoration-line underline-offset-[3px]"
          >
            {drawInlines(inline.children)}
          </a>
        );
    }
  });

/** Draws blocks. In a list item, a lone paragraph is drawn as bare text. */
const drawBlocks = (blocks: ReadonlyArray<ChecklistBlock>, bare: boolean): ReactNode =>
  blocks.map((block, index) => {
    if (block.type === "paragraph") {
      return bare ? (
        <Fragment key={index}>{drawInlines(block.children)}</Fragment>
      ) : (
        <p key={index}>{drawInlines(block.children)}</p>
      );
    }
    const items = block.items.map((item, itemIndex) => (
      <li key={itemIndex}>{drawBlocks(item, item.length === 1)}</li>
    ));
    return block.start === undefined ? (
      <ul key={index} className="list-disc space-y-1 pl-5 marker:text-faint">
        {items}
      </ul>
    ) : (
      <ol key={index} start={block.start} className="list-decimal space-y-1 pl-5 marker:text-faint">
        {items}
      </ol>
    );
  });

/**
 * The instructions of a setup `checklist` step: paragraphs, lists, emphasis,
 * code, and links to web addresses (see `readChecklist`), and nothing that
 * loads when the form opens.
 */
export function Checklist({ markdown }: { readonly markdown: string }): JSX.Element {
  return (
    <div className="flex max-w-[52ch] flex-col gap-2.5 text-row leading-relaxed text-muted">
      {drawBlocks(readChecklist(markdown), false)}
    </div>
  );
}
