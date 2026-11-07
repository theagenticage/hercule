import {
  flipByKey,
  type FlipByKeyResult,
  type FlipOptions,
  type SpringName,
} from "../../app/motion";

/** What moves when the board changes: cards, lane heads, the counts of folded lanes and the "13 more" lines. */
const MOVABLE_SELECTOR = "[data-card-id], [data-lane-head], [data-fold-row], [data-more-cell-id]";

/** Returns the key of the card `cardId` in the places `flipBoard` returns. */
export const buildCardKey = (cardId: string): string => `card:${cardId}`;

/**
 * Returns the key that tells the same part of the board apart across a
 * change, or `null` for an element that is not one. The card in the hand has
 * none, because the drag moves it.
 */
const readMotionKey = (element: HTMLElement): string | null => {
  if (element.hasAttribute("data-dragged")) return null;
  const { cardId, laneHead, foldRow, moreCellId } = element.dataset;
  if (cardId !== undefined) return buildCardKey(cardId);
  if (laneHead !== undefined) return `head:${laneHead}`;
  if (foldRow !== undefined) return `fold:${foldRow}`;
  if (moreCellId !== undefined) return `more:${moreCellId}`;
  return null;
};

/**
 * Runs `mutate`, which must commit its change to the page before it returns,
 * and moves every part of the board that the change moved from where it was to
 * where it is now, on `spring`. The parts are matched by Task, lane and cell,
 * not by element, because React makes a new element for a card that changes
 * cell (`flipByKey`). Returns the places of the parts after the change, and
 * the parts that are new.
 */
export const flipBoard = (
  scroller: HTMLElement,
  spring: SpringName,
  mutate: () => void,
  stagger?: FlipOptions["stagger"],
): FlipByKeyResult =>
  flipByKey({
    root: scroller,
    selector: MOVABLE_SELECTOR,
    readKey: readMotionKey,
    spring,
    mutate,
    ...(stagger === undefined ? {} : { stagger }),
  });
