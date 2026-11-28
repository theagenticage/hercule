import { useState, type JSX } from "react";
import type { CardOffers } from "@hercule/client-core/inbox";
import type { InboxThing, WorkflowOffer } from "@hercule/contract";
import { HandToMenu } from "../../../screens/inbox/hand-to-menu";

/**
 * Renders the menu of workflows `thing` can be handed to, under `anchor`. It
 * owns the account the user picks in the menu. `onHand` is called with the
 * workflow picked and that account (or `undefined` for the controller's own
 * choice); `onClose` when the menu is dismissed or a workflow is picked.
 *
 * The lines under the workflows name the asks each would end: the few asks the
 * row carries, then "and N more" from the row's exact `askCount`. The menu
 * never starts a read of its own.
 *
 * Orchestrating: it owns a piece of client state, the chosen account.
 */
export function InboxHandMenuPart({
  thing,
  offers,
  anchor,
  onHand,
  onClose,
}: {
  readonly thing: InboxThing;
  readonly offers: CardOffers;
  readonly anchor: HTMLElement;
  readonly onHand: (offer: WorkflowOffer, connectionId: string | undefined) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const [chosenConnectionId, setChosenConnectionId] = useState<string | undefined>(undefined);
  return (
    <HandToMenu
      offers={offers}
      thing={thing}
      actingConnections={thing.actingConnections}
      chosenConnectionId={chosenConnectionId}
      onChooseConnection={setChosenConnectionId}
      onHand={(workflowId) => {
        const offer = offers.available.find((each) => each.workflowId === workflowId);
        onClose();
        if (offer !== undefined) onHand(offer, chosenConnectionId);
      }}
      onClose={onClose}
      anchor={anchor}
    />
  );
}
