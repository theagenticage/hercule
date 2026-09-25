import type { JSX } from "react";
import { JsonText } from "./json-text";

/**
 * Renders a run's output, its terminal step's output, as indented JSON in a
 * card framed like the inputs card beside it. A long line wraps inside the
 * card, because the card is narrow and a line that scrolls sideways looks cut
 * off. A step's output in the step list wraps the same way.
 */
export function RunOutputCard({ output }: { readonly output: unknown }): JSX.Element {
  return (
    <JsonText
      value={output}
      className="rounded-card border border-line-soft bg-surface px-4 py-3"
    />
  );
}
