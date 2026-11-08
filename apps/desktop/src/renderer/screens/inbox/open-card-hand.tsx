import type { JSX } from "react";
import { describeHandOffEnds, type CardOffers } from "@hercule/client-core/inbox";
import type { ActingConnection } from "@hercule/contract";
import { buildLook, Face } from "../../faces";
import { HandAccount } from "./hand-account";

/** The size of a workflow's face on a row of the open card, in pixels. */
const FACE_SIZE = 22;

/** How many available workflows have a number key: 1 to 3. */
const NUMBERED_ROWS = 3;

/**
 * Focuses the first Hand to row inside `root`, or does nothing when there is
 * none. The key H uses it when several workflows can take the card: the user
 * then chooses with the arrow keys or a number.
 */
export const focusFirstHandRow = (root: ParentNode): void => {
  root.querySelector<HTMLElement>("[data-sheet-hand-row]")?.focus({ preventScroll: true });
};

/**
 * Renders the Hand to rows of the open card's moves, to sit in its ledger
 * before Take it:
 *
 * - one row for each available workflow, with its face, its name, the line of
 *   what the hand-off would end (`describeHandOffEnds` over `openKinds`) and
 *   its key. The key is H when there is one workflow and 1 to 3 when there are
 *   several. The first row is the accent one.
 * - the account the hand-off acts as, when there are several to choose from
 *   (`HandAccount`).
 * - the workflows that cannot take the card now, dimmed, each saying why.
 *
 * Pressing a row calls `onHand` with the workflow's id, and "keys" when the
 * press was Return or Space on the focused row (a click with no pointer, which
 * has `detail` 0), "pointer" otherwise. It renders nothing
 * for a card no workflow can take or could take.
 */
export function OpenCardHandRows({
  offers,
  openKinds,
  actingConnections,
  chosenConnectionId,
  onChooseConnection,
  onHand,
}: {
  readonly offers: CardOffers;
  readonly openKinds: readonly string[];
  readonly actingConnections: readonly ActingConnection[];
  readonly chosenConnectionId: string | undefined;
  readonly onChooseConnection: (connectionId: string) => void;
  readonly onHand: (workflowId: string, by: "keys" | "pointer") => void;
}): JSX.Element {
  const { available, unavailable } = offers;
  return (
    <>
      {available.map((offer, index) => (
        <button
          key={offer.workflowId}
          type="button"
          className={index === 0 ? "open-card-row is-first" : "open-card-row"}
          data-sheet-hand-row
          onClick={(event) => {
            onHand(offer.workflowId, event.detail === 0 ? "keys" : "pointer");
          }}
        >
          <span className="open-card-label">
            <Face look={buildLook(offer.workflowId)} pose="idle" size={FACE_SIZE} />
            {offer.name}
          </span>
          <span className="open-card-says">{describeHandOffEnds(offer, openKinds)}</span>
          {index < NUMBERED_ROWS && <kbd>{available.length === 1 ? "H" : index + 1}</kbd>}
        </button>
      ))}
      <HandAccount
        actingConnections={actingConnections}
        chosenConnectionId={chosenConnectionId}
        onChoose={onChooseConnection}
      />
      {unavailable.map((offer) => (
        <div key={offer.workflowId} className="open-card-row is-unavailable">
          <span className="open-card-label">
            <Face look={buildLook(offer.workflowId)} pose="idle" size={FACE_SIZE} />
            {offer.name}
          </span>
          <span className="open-card-says">{offer.unavailable?.message}</span>
        </div>
      ))}
    </>
  );
}
