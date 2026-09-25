import type { JSX } from "react";

/**
 * Renders a run's output, its terminal step's output, as indented JSON in a
 * card framed like the inputs card beside it. A long line wraps, breaking a
 * long string where it must, because the card is narrow and a line that
 * scrolls sideways looks cut off. A step's output in the step list wraps the
 * same way.
 */
export function RunOutputCard({ output }: { readonly output: unknown }): JSX.Element {
  return (
    <pre className="rounded-card border border-line-soft bg-surface px-4 py-3 font-mono text-fine leading-5 wrap-break-word whitespace-pre-wrap text-ink">
      {JSON.stringify(output, null, 2)}
    </pre>
  );
}
