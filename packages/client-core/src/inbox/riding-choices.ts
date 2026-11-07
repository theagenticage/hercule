/**
 * What the user's own Link and Unlink decide about what rides on what, for
 * the length of a visit. The visit holds what rides on what, so a read can
 * never move a card the user has seen (`placeInboxCards`). Only the user's own
 * Link and Unlink can, and they are kept here as `RidingChoices`.
 *
 * A Link or Unlink shows at once and the controller answers later, so it is
 * a `RidingMove` that waits in a `RidingLedger` until the answer comes. The
 * choices are never patched in place. They are worked out again from the
 * choices the answers settled and the moves still waiting, in the order the
 * user made them (`decideRidingChoices`). That is why a move the controller
 * refuses can be dropped without undoing a later move: the later moves are
 * played again on top of what is settled.
 */

/** Where the user's moves left a card: riding on the lead with this ref, or standing alone. */
export type RidingChoice =
  | { readonly _tag: "rides"; readonly lead: string }
  | { readonly _tag: "alone" };

/**
 * The choice made for each card in this visit, by card id. A card with no
 * entry has none: its place is what the visit holds. A choice wins over what
 * a read says, for the rest of the visit.
 */
export type RidingChoices = ReadonlyMap<string, RidingChoice>;

/** No choice made. */
export const NO_RIDING_CHOICES: RidingChoices = new Map();

/** The choice for a card that stands alone. One value, so callers compare it by `_tag`. */
const ALONE: RidingChoice = { _tag: "alone" };

/** Returns the ref of the lead `choice` puts the card on, or `undefined` when it stands alone. */
export const readChosenLead = (choice: RidingChoice): string | undefined =>
  choice._tag === "rides" ? choice.lead : undefined;

/** Returns the choice that puts a card on `lead`, or lets it stand alone when `lead` is `undefined`. */
export const chooseLead = (lead: string | undefined): RidingChoice =>
  lead === undefined ? ALONE : { _tag: "rides", lead };

/**
 * A Link or Unlink of a pair of which one end is a card that can ride and the
 * other a lead.
 *
 * - A link puts the card on `lead` when it rode on nothing. A card that rides
 *   on another lead already keeps it.
 * - An unlink takes the card off `lead` when it rode on that lead. A card that
 *   rides on another lead keeps it.
 */
export interface RidingMove {
  readonly kind: "link" | "unlink";
  readonly cardId: string;
  /** The ref of the lead at the other end of the pair. */
  readonly lead: string;
  /** Where the page showed the card just before the move was made. */
  readonly before: RidingChoice;
}

/** Returns where `move` leaves a card that was at `at`. */
const playRidingMove = (at: RidingChoice, move: RidingMove): RidingChoice => {
  if (move.kind === "link") return at._tag === "alone" ? chooseLead(move.lead) : at;
  return at._tag === "rides" && at.lead === move.lead ? ALONE : at;
};

/** A move the controller has not answered, and the gesture it belongs to. */
interface WaitingRidingMove {
  /** Names the gesture, so the answer can find its move. */
  readonly gesture: number;
  readonly move: RidingMove;
}

/** What has been settled by the controller's answers, and the moves still waiting for one. */
export interface RidingLedger {
  /** Where the answered moves left each card, by card id. */
  readonly settled: RidingChoices;
  /** The moves not yet answered, in the order the user made them. */
  readonly waiting: readonly WaitingRidingMove[];
}

/** A ledger with no move in it. */
export const EMPTY_RIDING_LEDGER: RidingLedger = { settled: NO_RIDING_CHOICES, waiting: [] };

/** Returns where the page stands for the card of `move`, before the move: what is settled, else where the page showed it. */
const readSettledChoice = (ledger: RidingLedger, move: RidingMove): RidingChoice =>
  ledger.settled.get(move.cardId) ?? move.before;

/** Returns `ledger` with `move` waiting for the controller's answer, as part of `gesture`. */
export const startRidingMove = (
  ledger: RidingLedger,
  gesture: number,
  move: RidingMove,
): RidingLedger => ({ ...ledger, waiting: [...ledger.waiting, { gesture, move }] });

/**
 * Returns `ledger` once the controller has answered `gesture`, or `ledger`
 * itself when `gesture` has no move waiting.
 *
 * `didChangeRiding` is whether the answer changed what rides on what. It is
 * false when the controller refused the move, and for an unlink whose answer
 * says a claim of a source still joins the pair, because the card still rides.
 * The card's place is settled either way: with the move played when
 * `didChangeRiding` is true, and without it otherwise. A move that waits
 * behind it is not touched.
 */
export const settleRidingMove = (
  ledger: RidingLedger,
  gesture: number,
  didChangeRiding: boolean,
): RidingLedger => {
  const answered = ledger.waiting.find((each) => each.gesture === gesture);
  if (answered === undefined) return ledger;
  const { move } = answered;
  const before = readSettledChoice(ledger, move);
  return {
    settled: new Map(ledger.settled).set(
      move.cardId,
      didChangeRiding ? playRidingMove(before, move) : before,
    ),
    waiting: ledger.waiting.filter((each) => each !== answered),
  };
};

/**
 * Returns the choices to hold for the visit: for each card with something
 * settled or waiting, where its settled place stands after the waiting moves
 * are played in the order they were made. A move that waits for a card whose
 * place is not settled starts from where the page showed the card when the
 * earliest of them was made. Returns `NO_RIDING_CHOICES` itself for a ledger
 * with nothing in it.
 */
export const decideRidingChoices = (ledger: RidingLedger): RidingChoices => {
  if (ledger.waiting.length === 0 && ledger.settled.size === 0) return NO_RIDING_CHOICES;
  const choices = new Map(ledger.settled);
  for (const { move } of ledger.waiting) {
    choices.set(move.cardId, playRidingMove(choices.get(move.cardId) ?? move.before, move));
  }
  return choices;
};
