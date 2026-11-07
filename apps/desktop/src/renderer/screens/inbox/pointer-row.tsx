import type { JSX } from "react";
import { decideCardFace } from "@hercule/client-core/inbox";
import type { InboxCard } from "@hercule/contract";
import { CardStatus } from "./card-parts";

/**
 * Renders a card that lies under a second place as a plain pointer: its
 * status, its title and "Also in ..." with the name of the place it is drawn
 * in full on. It is one card, drawn in full once and counted once, so the
 * pointer has nothing to act on of its own. `data-pointer-to` holds the card's
 * id, which the row it points to carries as `data-card-id`.
 */
export function PointerRow({
  card,
  alsoInName,
  showStatus,
}: {
  readonly card: InboxCard;
  readonly alsoInName: string;
  readonly showStatus: boolean;
}): JSX.Element {
  const face = decideCardFace(card);
  return (
    <div className="inbox-pointer" role="listitem" data-pointer-to={card.id}>
      <span className="row-rail">
        {showStatus && face.status !== undefined && <CardStatus status={face.status} size={15} />}
      </span>
      <span className="pointer-title">{face.title}</span>
      <small>Also in {alsoInName}</small>
    </div>
  );
}
