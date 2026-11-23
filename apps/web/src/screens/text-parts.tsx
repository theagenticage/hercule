import type { JSX } from "react";
import type { TextPart } from "@hercule/client-core/mcp-servers";

/** Draws the parts of a sentence a client-core model returns, the code spans in mono. */
export function TextParts({ parts }: { readonly parts: readonly TextPart[] }): JSX.Element {
  return (
    <>
      {parts.map((part, index) =>
        part.code ? (
          <code key={index} className="font-mono">
            {part.text}
          </code>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
