import type { JSX } from "react";
import { describeHandMove, NO_OFFERS, type CardOffers } from "@hercule/client-core/inbox";
import type { InboxCard } from "@hercule/contract";
import { buildLook, Face } from "../../faces";
import { ArrowIcon } from "../../icons/arrow";
import { CloseIcon } from "../../icons/close";

/**
 * Renders the moves of a card, each with its name, over the end of the card's
 * first line (a row) or second line (a request). They show while the card is
 * the current one (`data-current` on the card) and take no pointer otherwise.
 *
 * - A card that waits offers `Take it` and a close (Dismiss).
 * - A card with a live Task offers `On Work`, which goes to the Task.
 * - Either card offers a hand-off first, from `offers`: the workflow by name
 *   when one can take the card, `Hand to…` when several can, and nothing when
 *   none can. A hand-off continues the card's Task, so a card with a Task
 *   keeps it.
 *
 * The buttons carry `data-move`, which the page's clicks read, and stay out of
 * the Tab order: the keys H, T, E and G do the same. The hand-off button of a
 * single workflow also carries `data-workflow-id`, so a click on it hands the
 * card at once. Without that attribute it opens the menu (`HandToMenu`).
 * `offers` default to none, so a caller that has not read them draws no
 * hand-off.
 */
export function CardMoves({
  card,
  offers,
}: {
  readonly card: InboxCard;
  readonly offers?: CardOffers;
}): JSX.Element {
  return (
    <span className="card-moves">
      <HandMoveButton offers={offers ?? NO_OFFERS} />
      {card.taskId === undefined ? (
        <>
          <button
            type="button"
            tabIndex={-1}
            className="card-move card-move--take"
            data-move="take"
            title="Take it (T)"
          >
            Take it
          </button>
          <button
            type="button"
            tabIndex={-1}
            className="card-move"
            data-move="dismiss"
            title="Dismiss (E)"
            aria-label="Dismiss"
          >
            <CloseIcon size={14} />
          </button>
        </>
      ) : (
        <button
          type="button"
          tabIndex={-1}
          className="card-move card-move--go"
          data-move="see-task"
          title="See its Task on Work (G)"
        >
          On Work
          <ArrowIcon size={12} />
        </button>
      )}
    </span>
  );
}

/** The size of the faces on the hand-off button, in pixels. */
const HAND_FACE_SIZE = 18;

/**
 * Renders the hand-off button of a card, or nothing when no workflow can take
 * it. One workflow shows its face and name; several show the faces of the
 * first two and `Hand to…`. It draws the faces `buildLook` gives the workflow
 * id, as the menu and the rail do.
 */
function HandMoveButton({ offers }: { readonly offers: CardOffers }): JSX.Element | null {
  const hand = describeHandMove(offers);
  if (hand.kind === "none") return null;
  const isOne = hand.kind === "one";
  const shown = offers.available.slice(0, 2);
  return (
    <button
      type="button"
      tabIndex={-1}
      className="card-move card-move--hand"
      data-move="hand"
      data-workflow-id={isOne ? hand.offer.workflowId : undefined}
      title={isOne ? `Hand to ${hand.offer.name} (H)` : "Hand to an agent (H)"}
      aria-label={isOne ? `Hand to ${hand.offer.name}` : undefined}
      aria-haspopup={isOne ? undefined : "menu"}
    >
      {shown.map((offer) => (
        <Face
          key={offer.workflowId}
          look={buildLook(offer.workflowId)}
          pose="idle"
          size={HAND_FACE_SIZE}
        />
      ))}
      <span className="card-move-name">{isOne ? hand.offer.name : "Hand to…"}</span>
    </button>
  );
}

/**
 * Renders the user's monogram in a card's wait slot: the letters on the
 * marigold of `--you`. A card with a live Task shows it where the wait was.
 * People are words on a card and a monogram is kept for the user, so no
 * colleague's face is drawn here.
 *
 * The box clips the monogram, so it can rise into its place from below
 * (`riseMonogram` finds it by `.card-taken-in`).
 */
export function CardMonogram({ monogram }: { readonly monogram: string }): JSX.Element {
  return (
    <span className="card-taken" title="You have it">
      <span className="card-taken-in" aria-hidden="true">
        <span className="monogram">{monogram}</span>
      </span>
    </span>
  );
}

/**
 * Renders the colleague that has a card, in the place the wait had: the face
 * of the workflow `workflowId`, working, 22px: the same face the hand-off
 * button, the menu and the rail draw for it. It names itself for a screen
 * reader with `workflowName` ("Agent review has it"), and its face is hidden
 * from one.
 *
 * The box clips the face, so it can rise into its place from below and sink
 * out of it (`playHandOff` and `playHandOffBack` find the face by
 * `data-hand-off-colleague`). A card shows this where it shows `CardMonogram`
 * for the user.
 */
export function CardColleague({
  workflowId,
  workflowName,
}: {
  readonly workflowId: string;
  readonly workflowName: string;
}): JSX.Element {
  const name = `${workflowName} has it`;
  return (
    <span className="card-colleague" role="img" aria-label={name} title={name}>
      <span className="card-colleague-in" data-hand-off-colleague>
        <Face look={buildLook(workflowId)} pose="working" size={22} />
      </span>
    </span>
  );
}
