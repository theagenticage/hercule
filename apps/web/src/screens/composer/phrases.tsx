import type { JSX } from "react";
import type { Phrase } from "@hydra/client-core";

/**
 * A sentence the composer writes, as it is set: the git words in it - a
 * branch, a ref - in mono, the rest in the running face. Both places that read
 * one, the draft's lead and a menu's foot, set it the same way.
 */
export function Phrases({ parts }: { readonly parts: readonly Phrase[] }): JSX.Element {
  return (
    <>
      {parts.map((part, index) => (
        <span
          // The sentence is written whole each render, so its own order is the
          // only identity a part has.
          key={`${String(index)}:${part.text}`}
          className={part.mono === true ? "font-mono text-[0.95em]" : undefined}
        >
          {part.text}
        </span>
      ))}
    </>
  );
}
