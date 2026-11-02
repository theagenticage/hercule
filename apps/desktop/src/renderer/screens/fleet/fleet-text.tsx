import { Fragment, type JSX } from "react";
import type { FleetTextPart } from "@hercule/client-core/fleet";

/**
 * Renders a sentence of the Fleet screen from its parts: a `count` in the
 * "you" ink, a `number` in bold, and `plain` text as it is. The colour and
 * weight come from the stylesheet of the element around it.
 */
export function FleetText({ parts }: { readonly parts: readonly FleetTextPart[] }): JSX.Element {
  return (
    <>
      {parts.map((part, index) => {
        switch (part.kind) {
          case "count":
            return (
              <span key={index} className="is-you">
                {part.text}
              </span>
            );
          case "number":
            return <b key={index}>{part.text}</b>;
          case "plain":
            return <Fragment key={index}>{part.text}</Fragment>;
        }
      })}
    </>
  );
}
