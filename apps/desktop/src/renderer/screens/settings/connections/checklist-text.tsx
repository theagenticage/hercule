/**
 * The instructions of a setup `checklist` step, drawn from `readChecklist`:
 * paragraphs, lists, emphasis, code, and links to web addresses. Presentational.
 */
import { Fragment, type JSX, type ReactNode } from "react";
import { readChecklist, type ChecklistBlock, type ChecklistInline } from "@hercule/client-core";

/** Draws a run of inlines. A link opens in the default browser, where its address shows, and sends no referrer. */
const drawInlines = (inlines: ReadonlyArray<ChecklistInline>): ReactNode =>
  inlines.map((inline, index) => {
    switch (inline.type) {
      case "text":
        return <Fragment key={index}>{inline.text}</Fragment>;
      case "strong":
        return <strong key={index}>{drawInlines(inline.children)}</strong>;
      case "emphasis":
        return <em key={index}>{drawInlines(inline.children)}</em>;
      case "code":
        return <code key={index}>{inline.text}</code>;
      case "link":
        return (
          <a key={index} href={inline.href} target="_blank" rel="noreferrer">
            {drawInlines(inline.children)}
          </a>
        );
    }
  });

/** Draws blocks. In a list item, a lone paragraph is drawn as bare text, as a tight list is. */
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
      <ul key={index}>{items}</ul>
    ) : (
      <ol key={index} start={block.start}>
        {items}
      </ol>
    );
  });

/** Renders the Markdown of a checklist step as instructions. */
export function ChecklistText({ markdown }: { readonly markdown: string }): JSX.Element {
  return <div className="setup-checklist">{drawBlocks(readChecklist(markdown), false)}</div>;
}
