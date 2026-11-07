import {
  flipByKey,
  type FlipByKeyResult,
  type FlipByKeyOptions,
  type SpringName,
} from "../../app/motion";

/** What moves when the board changes: cards, lane heads, the counts of folded lanes and the "13 more" lines. */
const MOVABLE_SELECTOR = "[data-card-id], [data-lane-head], [data-fold-row], [data-more-cell-id]";

/**
 * Returns the key of each card element under `root`, in the places
 * `flipBoard` returns. A Task is one card, `card:<id>`, and keeps that key
 * when it moves to another lane, so it glides there. A Task under two outside
 * places has a card in each lane: its copies take `card:<id>` and
 * `card:<id>#2` in page order, so that each is matched with the copy in the
 * same position before and after a change.
 */
export const buildCardKeys = (root: ParentNode): ReadonlyMap<Element, string> => {
  const copies = new Map<string, number>();
  const keys = new Map<Element, string>();
  for (const element of root.querySelectorAll<HTMLElement>("[data-card-id]")) {
    const cardId = element.dataset["cardId"] ?? "";
    const copy = (copies.get(cardId) ?? 0) + 1;
    copies.set(cardId, copy);
    keys.set(element, copy === 1 ? `card:${cardId}` : `card:${cardId}#${String(copy)}`);
  }
  return keys;
};

/**
 * Returns the function that tells the same part of the board apart across a
 * change: a key, or `null` for an element that is not one. The card in the
 * hand has none, because the drag moves it, but it still counts as a copy of
 * its Task, so the other copy keeps its key while the card is in the hand.
 * `cardKeys` returns the keys of the cards as the page is now.
 */
const buildMotionKeyReader =
  (cardKeys: () => ReadonlyMap<Element, string>) =>
  (element: HTMLElement): string | null => {
    if (element.hasAttribute("data-dragged")) return null;
    const { laneHead, foldRow, moreCellId } = element.dataset;
    if (element.dataset["cardId"] !== undefined) return cardKeys().get(element) ?? null;
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
  stagger?: FlipByKeyOptions["stagger"],
): FlipByKeyResult => {
  // The card keys are worked out once for the page as it is before `mutate`,
  // and once for the page after it.
  let cardKeys: ReadonlyMap<Element, string> | undefined;
  return flipByKey({
    root: scroller,
    selector: MOVABLE_SELECTOR,
    readKey: buildMotionKeyReader(() => (cardKeys ??= buildCardKeys(scroller))),
    spring,
    mutate: () => {
      mutate();
      cardKeys = undefined;
    },
    ...(stagger === undefined ? {} : { stagger }),
  });
};
