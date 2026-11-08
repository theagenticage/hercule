import type { WorkBoard, WorkCard } from "@hercule/contract";
import { applyCardMove, buildMoveToPlacement, readPlacement } from "./card-move";

/**
 * A change the board shows only once the user's hand is still, because
 * nobody here caused it:
 *
 * - `arrival`: a Task that was not on the board before.
 * - `failure`: a Task whose run just failed. The card would take the top of
 *   its cell, so a card under the pointer could be sorted away from under it.
 * - `fact`: a card that changed stage because of a fact about a linked thing
 *   (a pull request merged), so nobody here moved it. It would cross the board
 *   under the pointer.
 */
export interface HeldChange {
  readonly kind: "arrival" | "failure" | "fact";
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
/**
 * Returns the key that releases the move of `card` into the stage it is in
 * now, so each move has a key of its own. A move by a fact is named by the
 * fact's id, which never repeats. A move with no cause (a drag from another
 * client, which the morning replay also plays) is named by the time the stage
 * changed.
 */
export const buildFactKey = (card: WorkCard): string =>
  card.stageCause === undefined
    ? `fact:${card.id}:${card.stageChangedAt}`
    : `fact:${card.id}:fact-${String(card.stageCause.factId)}`;

const NO_KEYS: ReadonlySet<string> = new Set();

/** Returns the key of the failure that `card` shows, or `undefined` when it shows none. */
const readFailureKey = (card: WorkCard): string | undefined =>
  card.failure === undefined ? undefined : buildFailureKey(card.failure.runId);

/** Returns whether two values from a board read are equal. Values from one read share their objects, so most pairs end at the first check. */
const isSameValue = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Returns the key of the fact that moved `card` since the board showed
 * `before`, or `undefined` when no fact did. A stage change counts as a fact's
 * only when it comes with a `stageCause` that `before` did not have: a drag from
 * another client or an undo changes the stage and leaves the cause out.
 *
 * The key holds the id of the fact (`buildFactKey`), so that each move by a
 * fact has a key of its own: releasing one does not release the next fact for
 * the same card, even when its words are the same ("PR #6221 merged" after a
 * relink).
 *
 * A stage change whose key is in `alsoHeld` counts too, with or without words:
 * the morning replay holds every move it plays.
 */
const readFactKey = (
  card: WorkCard,
  before: WorkCard,
  alsoHeld: ReadonlySet<string>,
): string | undefined => {
  if (card.stage === before.stage) return undefined;
  const key = buildFactKey(card);
  const hasNewCause =
    card.stageCause !== undefined && !isSameValue(card.stageCause, before.stageCause);
  return hasNewCause || alsoHeld.has(key) ? key : undefined;
};

/** Returns whether every field of the two boards other than `cards` is equal. */
const isSameBoardExceptCards = (a: WorkBoard, b: WorkBoard): boolean =>
  Object.entries(b).every(
    ([field, value]) => field === "cards" || isSameValue(value, a[field as keyof WorkBoard]),
  );

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
 * Returns `board` with the card `cardId` back in the stage and place it has in
 * `shown`, with the `stageCause` and `stageChangedAt` it has there: after the card that stood before
 * it in its cell, or last in the cell when that card is gone. The card keeps
 * the Project it has in `board`. Returns `board` itself when either board has
 * no such card.
 */
const putBackInShownPlace = (board: WorkBoard, shown: WorkBoard, cardId: string): WorkBoard => {
  const placement = readPlacement(shown, cardId);
  const current = board.cards.find((card) => card.id === cardId);
  const before = shown.cards.find((card) => card.id === cardId);
  if (placement === undefined || current === undefined || before === undefined) return board;
  const { move } = buildMoveToPlacement(board, {
    ...placement,
    projectId: current.projectId ?? null,
  });
  const moved = applyCardMove(board, move);
  return {
    ...moved,
    cards: moved.cards.map((card) => {
      if (card.id !== cardId) return card;
      const { stageCause, ...withoutCause } = card;
      void stageCause;
      const shownStage = { stageChangedAt: before.stageChangedAt };
      return before.stageCause === undefined
        ? { ...withoutCause, ...shownStage }
        : { ...withoutCause, ...shownStage, stageCause: before.stageCause };
    }),
  };
};

/**
 * Returns the drawn board, given the board `shown` now and the `latest`
 * logical board (`buildLogicalBoard`), and the changes of `latest` that it holds
 * back. Everything else in `latest` is shown at once, including every field
 * that is not a card (the places, edges, groupings and `contextComplete`): only
 * cards wait. This is the one place that decides what waits for a still hand,
 * so `arrangeCell` stays pure.
 *
 * - A card that is new to `shown` is left out until its `arrival` key is in
 *   `released`. A card in `hiddenBefore` is not new: the user's own gesture
 *   took it off the board and it comes back, so it is drawn at once.
 * - A card whose run just failed (it shows a failure `shown` does not) keeps
 *   the failure it has in `shown` (none, or the one before) until its
 *   `failure` key is in `released`, so it does not rise to the top of its cell
 *   yet. Its stage, project and order are the latest: a card the user moved
 *   stays where the user put it.
 * - A card that changed stage by a fact (its `stageCause` is new, see
 *   `readFactKey`) stays in the stage and place `shown` has until its `fact`
 *   key is in `released`. A stage change with no new cause (a drag from
 *   another client, an undo) is shown at once, and so is a card the user's
 *   own move changed, because `applyCardMove` clears its cause. Whether a card
 *   is in the user's hand is not decided here: the caller releases a held
 *   change only when the hand is still. A stage change whose `buildFactKey`
 *   is in `alsoHeldFactKeys` is held the same way though it has no new cause,
 *   which is how the morning replay holds the moves it plays.
 * - A card in `movedByUser` has a stage move of the user's own that the
 *   controller has not answered yet (`LogicalBoard.movedIds`). Its move is
 *   never held and never put back: the user put the card there, and whatever
 *   waited for it (a fact's cause, a replayed move) leaves with it.
 *
 * Returns `shown` itself when nothing differs in any field, so the caller can
 * tell that nothing changed by comparing references.
 */
export const holdBackBoardChanges = (
  shown: WorkBoard,
  latest: WorkBoard,
  released: ReadonlySet<string>,
  hiddenBefore: ReadonlySet<string>,
  alsoHeldFactKeys: ReadonlySet<string> = NO_KEYS,
  movedByUser: ReadonlySet<string> = NO_KEYS,
): HeldBoard => {
  const shownById = new Map(shown.cards.map((card) => [card.id, card]));
  const held: HeldChange[] = [];
  const cards: WorkCard[] = [];
  const factCardIds: string[] = [];
  for (const card of latest.cards) {
    const before = shownById.get(card.id);
    if (before === undefined) {
      const key = buildArrivalKey(card.id);
      if (released.has(key) || hiddenBefore.has(card.id)) cards.push(card);
      else held.push({ kind: "arrival", cardId: card.id, key });
      continue;
    }
    let drawn = card;
    const failureKey = readFailureKey(card);
    if (failureKey !== undefined && failureKey !== readFailureKey(before)) {
      if (!released.has(failureKey)) {
        held.push({ kind: "failure", cardId: card.id, key: failureKey });
        drawn = keepShownFailure(card, before);
      }
    }
    const factKey = movedByUser.has(card.id)
      ? undefined
      : readFactKey(card, before, alsoHeldFactKeys);
    if (factKey !== undefined && !released.has(factKey)) {
      held.push({ kind: "fact", cardId: card.id, key: factKey });
      factCardIds.push(card.id);
    }
    cards.push(drawn);
  }
  const withFactsHeld = factCardIds.reduce<WorkBoard>(
    (board, cardId) => putBackInShownPlace(board, shown, cardId),
    { ...latest, cards },
  );
  const isUnchanged =
    withFactsHeld.cards.length === shown.cards.length &&
    withFactsHeld.cards.every((card, index) => isSameValue(card, shown.cards[index])) &&
    isSameBoardExceptCards(shown, latest);
  return { board: isUnchanged ? shown : withFactsHeld, held };
};
