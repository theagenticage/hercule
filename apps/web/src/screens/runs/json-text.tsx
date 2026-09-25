import type { JSX } from "react";
import { listJsonLines } from "@hercule/client-core";
import { cn } from "@hercule/ui";

/**
 * Renders a JSON value as indented text, two spaces a level. A line too long
 * for its box wraps, breaking a long string where it must, and the wrapped
 * part lines up one level deeper than the line's own indent, so the shape of
 * the JSON stays readable in a narrow box. Each line keeps its leading
 * spaces, so copied text keeps its indent.
 */
export function JsonText({
  value,
  className,
}: {
  readonly value: unknown;
  /** A class for the box, such as its border and padding. */
  readonly className?: string;
}): JSX.Element {
  return (
    <pre
      className={cn(
        "font-mono text-fine leading-5 wrap-break-word whitespace-pre-wrap text-ink",
        className,
      )}
    >
      {listJsonLines(value).map(({ depth, text }, index) => {
        // The line's first row starts at the box's edge, with its indent
        // written as spaces; each wrapped row starts one level deeper.
        const hang = `${String(2 * (depth + 1))}ch`;
        return (
          <span key={index} className="block" style={{ paddingLeft: hang, textIndent: `-${hang}` }}>
            {" ".repeat(2 * depth)}
            {text}
          </span>
        );
      })}
    </pre>
  );
}
