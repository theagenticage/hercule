import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { EMPTY_FILTER, isFilterOn } from "@hercule/client-core/desk";
import { walkBoard, type CardMove, type WorkProject } from "@hercule/client-core/work";
import type { BoardStage, WorkCard } from "@hercule/contract";
import { isTextField } from "../../app/text-field";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { listShownCards, type ArrangedLane } from "./arrange-lanes";
import { describeCardMove } from "./describe-card-move";
import { keepCardInView } from "./keep-in-view";
import { chooseTargetStage, readBoardKey } from "./read-board-key";
import { buildCellId, type WorkView } from "./use-work-view";

/** How far in pixels the pointer must travel before it counts as moved. A card sliding under a resting pointer must not take over from the keys. */
const POINTER_MOVE_MIN = 4;

/**
 * What a key press can land on without being the board's: a menu or popover, a
 * dialog, and the Add to Work sheet. They keep their own keys.
 */
const OVERLAY_SELECTOR = "[popover], dialog, [role='menu'], .side-sheet";

/** Matches a popover or a dialog that is open right now, which closes itself on Esc. */
const OPEN_OVERLAY_SELECTOR = 'dialog[open], [popover="auto"]:popover-open';

/** What `useBoardKeys` needs from the Work screen. */
export interface BoardKeysInput {
  readonly view: WorkView;
  /** Every card of the board. */
  readonly cards: readonly WorkCard[];
  /** The lanes as the board draws them, which decide what the arrows can reach. */
  readonly arranged: readonly ArrangedLane[];
  /** The cards the Find list offers, in the order it lists them. */
  readonly findMatches: readonly WorkCard[];
  readonly projects: readonly WorkProject[];
  /** The platform decides whether undo is ⌘Z or Ctrl Z. */
  readonly platform: DesktopPlatform;
  readonly moves: {
    /** Moves a card on screen at once and sends the move. */
    readonly moveCard: (move: CardMove, words: string) => void;
    /** Puts back the newest gesture of the user. */
    readonly undoLastMove: () => void;
  };
  /**
   * Returns whether a card is in the hand in a drag, as of the key press. The
   * drag owns Esc then, and no other key means anything.
   */
  readonly isCarrying: () => boolean;
  /** The element that scrolls the board. */
  readonly scrollRef: RefObject<HTMLElement | null>;
  /** The Find box's input. */
  readonly findRef: RefObject<HTMLInputElement | null>;
  readonly onOpenCard: (card: WorkCard) => void;
  /** Opens Add to Work in the lane of the current card. */
  readonly onAdd: () => void;
  /** The Add to Work sheet: whether it is open, and a way to close it. */
  readonly addSheet: { readonly isOpen: boolean; readonly close: () => void };
}

/** What `useBoardKeys` gives back to the screen. */
export interface BoardKeys {
  readonly isKeysSheetOpen: boolean;
  /** The id of the Find match the arrow keys are on, or `null` when Find lists none. */
  readonly activeFindId: string | null;
  /** Takes the keys of the Find box: the arrows walk the matches, Return opens one, Esc clears the text. */
  readonly handleFindKeys: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}

/** Returns the arranged lane that holds the card `cardId`, shown or hidden, or `undefined`. */
const findLaneOfCard = (
  arranged: readonly ArrangedLane[],
  cardId: string | null,
): ArrangedLane | undefined =>
  arranged.find(({ cells }) =>
    cells.some(
      ({ arranged: cell }) =>
        cell.cards.some((card) => card.id === cardId) ||
        cell.hiddenCards.some((card) => card.id === cardId),
    ),
  );

/**
 * Listens to the keys of the Work board for as long as the screen is mounted,
 * and returns the state those keys leave on the screen: the keys sheet, and
 * which Find match is active. The keys are in `readBoardKey`.
 *
 * - A key is the board's only when focus is on the page itself or on
 *   something inside the board, and never in a text field, a menu, a dialog or
 *   the Add to Work sheet. Undo and Esc also work from the toolbar.
 * - The current card is the one under the pointer, until an arrow key takes
 *   over from the pointer, and then the card with focus.
 * - Esc steps back one thing at a time: the keys sheet, the Add to Work sheet,
 *   the Find text, then the filter. An open menu closes itself first.
 * - While a card is in the hand of a drag, no key does anything here.
 */
export const useBoardKeys = (input: BoardKeysInput): BoardKeys => {
  const { view, cards, arranged, findMatches, projects, moves, scrollRef, findRef } = input;
  const [isKeysSheetOpen, setKeysSheetOpen] = useState(false);
  const [chosenMatch, setChosenMatch] = useState<{ text: string; id: string } | null>(null);
  const hoveredCardId = useRef<string | null>(null);

  // Find: the first match is active until an arrow key chooses another. A
  // choice belongs to the text it was made for, so typing starts at the top.
  const activeFindId =
    chosenMatch !== null &&
    chosenMatch.text === view.findText &&
    findMatches.some((card) => card.id === chosenMatch.id)
      ? chosenMatch.id
      : (findMatches[0]?.id ?? null);

  const handleFindKeys = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      view.setFindText("");
      event.currentTarget.blur();
    } else if (event.key === "Enter") {
      const match = findMatches.find((card) => card.id === activeFindId);
      if (match !== undefined) input.onOpenCard(match);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const at = findMatches.findIndex((card) => card.id === activeFindId);
      const next =
        findMatches[
          Math.max(0, Math.min(findMatches.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))
        ];
      if (next !== undefined) setChosenMatch({ text: view.findText, id: next.id });
    }
  };

  const findCardElement = (cardId: string): HTMLElement | null =>
    scrollRef.current?.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`) ?? null;

  /** Moves focus to the card, keeps it in view, and hands the keys over from the pointer. Returns whether the card is on screen. */
  const focusCard = (cardId: string): boolean => {
    const element = findCardElement(cardId);
    if (element === null) return false;
    hoveredCardId.current = null;
    element.focus({ preventScroll: true });
    if (scrollRef.current !== null) keepCardInView(scrollRef.current, element);
    return true;
  };

  /** Folds or opens lanes with `change`, and keeps focus on the lane's head when the focused card folds away with it. */
  const changeFoldsKeepingFocus = (change: () => void, laneId: string | undefined): void => {
    const scroller = scrollRef.current;
    const hadFocusInBoard = scroller?.contains(document.activeElement) === true;
    flushSync(change);
    if (!hadFocusInBoard || laneId === undefined || document.activeElement !== document.body) {
      return;
    }
    scroller
      ?.querySelector<HTMLElement>(`[data-lane-head="${laneId}"] .board-lane-button`)
      ?.focus({ preventScroll: true });
  };

  /** Moves the card to the end of the cell of `stage` in its own lane, and keeps focus on it when it had focus. */
  const moveCardToStage = (card: WorkCard, stage: BoardStage): void => {
    const hadFocus = document.activeElement === findCardElement(card.id);
    const laneId = findLaneOfCard(arranged, card.id)?.lane.id;
    const move: CardMove = { taskId: card.id, stage };
    // Committed at once: the card is a new element in its new cell, and focus can only go to it once it is there.
    flushSync(() => {
      moves.moveCard(move, describeCardMove(card, move, projects));
    });
    if (!hadFocus || focusCard(card.id) || laneId === undefined) return;
    // The cell shows only some of its cards, and the moved one is behind its
    // line ("3 landed", "13 more"). Focus goes to that line.
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-more-cell-id="${buildCellId(laneId, stage)}"]`)
      ?.focus({ preventScroll: true });
  };

  const stepBack = (event: KeyboardEvent): void => {
    if (document.querySelector(OPEN_OVERLAY_SELECTOR) !== null) return;
    if (isKeysSheetOpen) {
      setKeysSheetOpen(false);
    } else if (input.addSheet.isOpen) {
      input.addSheet.close();
    } else if (view.findText !== "") {
      view.setFindText("");
    } else if (isFilterOn(view.filter)) {
      view.setFilter(EMPTY_FILTER);
    } else {
      return;
    }
    event.preventDefault();
  };

  const handleKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || input.isCarrying() || isTextField(event.target)) return;
    const command = readBoardKey(event, view.display.hasSingleKeys, input.platform);
    if (command === null || (event.repeat && command.kind !== "walk")) return;
    if (command.kind === "step-back") {
      stepBack(event);
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(OVERLAY_SELECTOR) != null) return;
    const isOnBoard = target === document.body || scrollRef.current?.contains(target) === true;
    if (command.kind === "undo") {
      event.preventDefault();
      moves.undoLastMove();
      return;
    }
    if (!isOnBoard) return;

    const shown = listShownCards(arranged);
    const shownIds = new Set(shown.flat(2));
    const hoveredId = hoveredCardId.current;
    // The card under a resting pointer, else the one with focus.
    const currentId =
      hoveredId !== null && shownIds.has(hoveredId)
        ? hoveredId
        : view.currentCardId !== null && shownIds.has(view.currentCardId)
          ? view.currentCardId
          : null;
    const currentCard = cards.find((card) => card.id === currentId);

    switch (command.kind) {
      case "walk": {
        event.preventDefault();
        const next = walkBoard(shown, currentId ?? undefined, command.walk);
        if (next !== undefined) focusCard(next);
        return;
      }
      case "open-card":
        // On a button, Return and Space press that button. Only a card, or the page itself, is the board's.
        if (target !== document.body && target?.matches(".desk-card") !== true) return;
        if (currentCard === undefined) return;
        event.preventDefault();
        input.onOpenCard(currentCard);
        return;
      case "shift-stage":
      case "pick-stage": {
        event.preventDefault();
        const stage =
          currentCard === undefined ? undefined : chooseTargetStage(currentCard, command);
        if (currentCard !== undefined && stage !== undefined) moveCardToStage(currentCard, stage);
        return;
      }
      case "add":
        event.preventDefault();
        input.onAdd();
        return;
      case "fold-lane": {
        const laneId =
          target?.closest<HTMLElement>("[data-lane-id]")?.dataset.laneId ??
          findLaneOfCard(arranged, view.currentCardId)?.lane.id;
        if (laneId === undefined) return;
        event.preventDefault();
        changeFoldsKeepingFocus(() => {
          view.toggleLane(laneId);
        }, laneId);
        return;
      }
      case "fold-all-lanes":
        event.preventDefault();
        changeFoldsKeepingFocus(() => {
          view.foldEverything(arranged.map((each) => each.lane.id));
        }, findLaneOfCard(arranged, view.currentCardId)?.lane.id);
        return;
      case "find":
        event.preventDefault();
        findRef.current?.focus();
        findRef.current?.select();
        return;
      case "toggle-keys-sheet":
        setKeysSheetOpen(!isKeysSheetOpen);
        return;
    }
  };

  // The listener is added once and calls the newest handler, which reads the
  // newest state and props.
  const handlerRef = useRef<((event: KeyboardEvent) => void) | null>(null);
  useLayoutEffect(() => {
    handlerRef.current = handleKey;
  });
  useEffect(() => {
    const listen = (event: KeyboardEvent): void => {
      handlerRef.current?.(event);
    };
    window.addEventListener("keydown", listen);
    return () => {
      window.removeEventListener("keydown", listen);
    };
  }, []);

  // The card under the pointer is the current card, once the pointer really
  // moves. An arrow key hands the current card back to the keys (`focusCard`).
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    let x = 0;
    let y = 0;
    const onPointerMove = (event: PointerEvent): void => {
      if (Math.hypot(event.clientX - x, event.clientY - y) < POINTER_MOVE_MIN) return;
      x = event.clientX;
      y = event.clientY;
      hoveredCardId.current =
        event.target instanceof Element
          ? (event.target.closest<HTMLElement>("[data-card-id]")?.dataset.cardId ?? null)
          : null;
    };
    const onPointerLeave = (): void => {
      hoveredCardId.current = null;
    };
    scroller.addEventListener("pointermove", onPointerMove);
    scroller.addEventListener("pointerleave", onPointerLeave);
    return () => {
      scroller.removeEventListener("pointermove", onPointerMove);
      scroller.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [scrollRef]);

  return { isKeysSheetOpen, activeFindId, handleFindKeys };
};
