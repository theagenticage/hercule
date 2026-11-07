import type { WorkBoard, WorkCard } from "@hercule/contract";

/**
 * A change the board shows only once the user's hand is still, because
 * nobody here caused it:
 *
 * - `arrival`: a Task that was not on the board before.
 * - `failure`: a Task whose run just failed. The card would take the top of
 *   its cell, so a card under the pointer could be sorted away from under it.
 */
export interface HeldChange {
  readonly kind: "arrival" | "failure";
  readonly cardId: string;
  /** Names this one change, so that releasing it once does not release the next failure of the same Task. */
  readonly key: string;
}

/** The board to draw, and the changes it leaves out for now. */
export interface HeldBoard {
  readonly board: WorkBoard;
  readonly held: readonly HeldChange[];
}

/** Returns the key that releases the arrival of the Task `cardId`. */
export const buildArrivalKey = (cardId: string): string => `arrival:${cardId}`;
const buildFailureKey = (runId: string): string => `failure:${runId}`;

/** Returns the key of the failure that `card` shows, or `undefined` when it shows none. */
const readFailureKey = (card: WorkCard): string | undefined =>
  card.failure === undefined ? undefined : buildFailureKey(card.failure.runId);

/** Returns whether two cards show the same facts. Cards from one read share their objects, so most pairs end at the first check. */
const isSameCard = (a: WorkCard, b: WorkCard): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Returns `card` with the failure that `before` shows, or none when `before`
 * shows none. Everything else stays as `card` has it. The failure is the only
 * thing that makes `arrangeCell` lead a cell with the card, so holding it
 * keeps the card where it was and leaves a move the user made.
 */
const keepShownFailure = (card: WorkCard, before: WorkCard): WorkCard => {
  const { failure, ...withoutFailure } = card;
  void failure;
  return before.failure === undefined
    ? withoutFailure
    : { ...withoutFailure, failure: before.failure };
};

/**
 * Returns the board to draw, given the board `shown` now and the `latest`
 * board, and the changes of `latest` that it holds back. Everything else in
 * `latest` is shown at once. This is the one place that decides what waits
 * for a still hand, so `arrangeCell` stays pure.
 *
 * - A card that is new to `shown` is left out until its `arrival` key is in
 *   `released`.
 * - A card whose run just failed (it shows a failure `shown` does not) keeps
 *   the failure it has in `shown` (none, or the one before) until its
 *   `failure` key is in `released`, so it does not rise to the top of its cell
 *   yet. Its stage, project and order are the latest: a card the user moved
 *   stays where the user put it.
 *
 * Returns `shown` itself when nothing differs, so the caller can tell that
 * nothing changed by comparing references.
 */
export const holdBackBoardChanges = (
  shown: WorkBoard,
  latest: WorkBoard,
  released: ReadonlySet<string>,
): HeldBoard => {
  const shownById = new Map(shown.cards.map((card) => [card.id, card]));
  const held: HeldChange[] = [];
  const cards: WorkCard[] = [];
  for (const card of latest.cards) {
    const before = shownById.get(card.id);
    if (before === undefined) {
      const key = buildArrivalKey(card.id);
      if (released.has(key)) cards.push(card);
      else held.push({ kind: "arrival", cardId: card.id, key });
      continue;
    }
    const failureKey = readFailureKey(card);
    if (failureKey !== undefined && failureKey !== readFailureKey(before)) {
      if (released.has(failureKey)) cards.push(card);
      else {
        held.push({ kind: "failure", cardId: card.id, key: failureKey });
        cards.push(keepShownFailure(card, before));
      }
      continue;
    }
    cards.push(card);
  }
  const isUnchanged =
    latest.truncated === shown.truncated &&
    cards.length === shown.cards.length &&
    cards.every((card, index) => isSameCard(card, shown.cards[index]!));
  return { board: isUnchanged ? shown : { ...latest, cards }, held };
};
