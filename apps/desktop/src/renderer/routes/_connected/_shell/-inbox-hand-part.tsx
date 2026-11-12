import { useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { readHandOffAsks, type CardOffers } from "@hercule/client-core/inbox";
import { queryKeys } from "@hercule/client-core";
import type { ExternalEntityDetail, InboxThing, WorkflowOffer } from "@hercule/contract";
import { HandToMenu } from "../../../screens/inbox/hand-to-menu";

/**
 * Renders the menu of workflows `thing` can be handed to, under `anchor`. It
 * owns the account the user picks in the menu. `onHand` is called with the
 * workflow picked and that account (or `undefined` for the controller's own
 * choice); `onClose` when the menu is dismissed or a workflow is picked.
 *
 * The lines under the workflows name the asks each would end. They come from
 * the pane's detail of `thing` when it is cached, which lists every open ask,
 * and otherwise from the few asks the row carries, with "and N more". The menu
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
  const queryClient = useQueryClient();
  const detail = queryClient.getQueryData<ExternalEntityDetail>(queryKeys.externalEntity(thing.id));
  const asks = detail === undefined ? thing : readHandOffAsks(thing, detail.signals);
  const [chosenConnectionId, setChosenConnectionId] = useState<string | undefined>(undefined);
  return (
    <HandToMenu
      offers={offers}
      thing={asks}
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
