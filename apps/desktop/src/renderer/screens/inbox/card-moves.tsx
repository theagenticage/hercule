import type { JSX } from "react";
import type { InboxCard } from "@hercule/contract";
import { ArrowIcon } from "../../icons/arrow";
import { CloseIcon } from "../../icons/close";

/**
 * Renders the moves of a card, each with its name, over the end of the card's
 * first line (a row) or second line (a request). They show while the card is
 * the current one (`data-current` on the card) and take no pointer otherwise.
 *
 * - A card that waits offers `Take it` and a close (Dismiss).
 * - A card with a live Task offers `On Work`, which goes to the Task.
 *
 * The buttons carry `data-move`, which the page's clicks read, and stay out of
 * the Tab order: the keys T, E and G do the same.
 */
export function CardMoves({ card }: { readonly card: InboxCard }): JSX.Element {
  return (
    <span className="card-moves">
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
