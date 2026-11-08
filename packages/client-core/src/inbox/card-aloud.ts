/** What a screen reader says for a card of the Inbox. */
import type { CardFace } from "./card-face";
import type { CardWait } from "./card-wait";

/**
 * Returns the words a screen reader says for a card, in the order a person
 * would ask: what it is, how the source names it, its title, whose it is, why
 * it is here, its status, how long it has waited, and how many things ride on
 * it (`riderCount`, 0 for none). A slot the card does not have is left out.
 */
export const describeCardAloud = (
  face: CardFace,
  wait: CardWait | null,
  riderCount: number,
): string =>
  [
    face.noun,
    face.identifier,
    face.title,
    face.whose,
    face.sentence?.text,
    face.status?.label,
    wait?.words,
    riderCount === 0
      ? undefined
      : `with ${String(riderCount)} ${riderCount === 1 ? "thing" : "things"} riding on it`,
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(", ");
