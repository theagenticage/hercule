import type { JSX } from "react";
import type { CardFact } from "@hercule/client-core/inbox";

/**
 * Renders a fact in its fixed form. A delta draws its gain and its loss in
 * two colours. A form the row does not draw, such as the priority bars that
 * wait for the open card, draws nothing.
 */
export function CardFactText({ fact }: { readonly fact: CardFact }): JSX.Element | null {
  if (fact.form === "bars") return null;
  if (fact.form === "delta") {
    return (
      <span className="card-fact">
        <span className="fact-added">{fact.added}</span>
        <span className="fact-removed">{fact.removed}</span>
      </span>
    );
  }
  return <span className="card-fact">{fact.text}</span>;
}
