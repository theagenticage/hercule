import type { JSX } from "react";
import type { Phrase } from "@hercule/client-core";

/**
 * Renders a sentence built by the composer. Git names in it, such as a branch
 * or a ref, are set in mono and the rest in the body font. The draft's lead
 * and a menu's foot both use this, so they look the same.
 */
export function Phrases({ parts }: { readonly parts: readonly Phrase[] }): JSX.Element {
  return (
    <>
      {parts.map((part, index) => (
        <span
          // The sentence is rebuilt on every render, so a part's position is
          // the only stable identity it has.
          key={`${String(index)}:${part.text}`}
          className={part.mono === true ? "font-mono text-[0.95em]" : undefined}
        >
          {part.text}
        </span>
      ))}
    </>
  );
}
