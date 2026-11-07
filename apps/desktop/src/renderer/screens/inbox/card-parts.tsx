import type { JSX } from "react";
import type { EntityStatus } from "@hercule/contract";
import type { CardFact, CardWait } from "@hercule/client-core/inbox";
import { StatusShape } from "../desk";

/** Renders a status as its shape and its word in ink: the first thing on a row, and the line of a place's head. */
export function CardStatus({
  status,
  size,
}: {
  readonly status: EntityStatus;
  readonly size: number;
}): JSX.Element {
  return (
    <span className="card-status">
      <StatusShape shape={status.shape} tone={status.tone} size={size} />
      <span>{status.label}</span>
    </span>
  );
}

/**
 * Renders how long a card has waited: ink and weight only, on the ramp the
 * patience of its kind sets (`data-level`). The words for a screen reader are
 * the tooltip and the card's label.
 */
export function CardWaitFigure({ wait }: { readonly wait: CardWait }): JSX.Element {
  return (
    <span className="card-wait" data-level={wait.level} title={wait.words}>
      {wait.text}
    </span>
  );
}

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
