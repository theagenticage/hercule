import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { EMPTY_FILTER, isFilterOn } from "@hercule/client-core/desk";
import {
  buildCellId,
  chooseLaneId,
  chooseTargetStage,
  describeCardMove,
  listShownCardIds,
  walkBoard,
  type ArrangedLane,
  type CardMove,
  type EndStage,
  type WalkStop,
  type WorkProject,
} from "@hercule/client-core/work";
import type { BoardStage, WorkCard } from "@hercule/contract";
import { isTextField } from "../../app/text-field";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { keepCardInView } from "./keep-in-view";
import { readBoardKey } from "./read-board-key";
import type { MergePick } from "./use-merge-pick";
import type { WorkView } from "./use-work-view";

/** How far in pixels the pointer must travel before it counts as moved. A card sliding under a resting pointer must not take over from the keys. */
const POINTER_MOVE_MIN = 4;

/**
 * What a key press can land on without being the board's: a menu or popover, a
 * dialog, and the Add to Work sheet. They keep their own keys.
 */
const OVERLAY_SELECTOR = "[popover], dialog, [role='menu'], .side-sheet, .opening-sheet";

/** Matches a popover or a dialog that is open right now, which closes itself on Esc. */
const OPEN_OVERLAY_SELECTOR = 'dialog[open], [popover="auto"]:popover-open';

/** What `useBoardKeys` needs from the Work screen. */
export interface BoardKeysInput {
  readonly view: WorkView;
  /** Every card of the board. */
  readonly cards: readonly WorkCard[];
  /** The lanes as the board draws them, which decide what the arrows can reach. */
  readonly arrangedLanes: readonly ArrangedLane[];
  /** The cards the Find list offers, in the order it lists them. */
  readonly findMatches: readonly WorkCard[];
  readonly projects: readonly WorkProject[];
  /** The platform decides whether undo is ⌘Z or Ctrl Z. */
  readonly platform: DesktopPlatform;
  readonly moves: {
    /** Moves a card on screen at once, gliding the cards, and sends the move. */
    readonly moveCardWithMotion: (move: CardMove, words: string) => void;
    /** Puts back the newest gesture of the user. */
    readonly undoLastMove: () => void;
  };
  /** Whether a card is in the hand of a drag. The drag owns Esc then, and no other key means anything. */
  readonly isCarrying: boolean;
  /** The element that scrolls the board. */
  readonly scrollRef: RefObject<HTMLElement | null>;
  /** The Find box's input. */
  readonly findRef: RefObject<HTMLInputElement | null>;
  readonly onOpenCard: (card: WorkCard) => void;
  /** Marks the card Done or Dropped (`D`, `⌫`). */
  readonly onEndCard: (card: WorkCard, stage: EndStage) => void;
  /** Asks what a new Thread on the card should do (`T`). */
  readonly onStartThread: (card: WorkCard) => void;
  /** Selects the card, or takes it out of the selection (`X`). */
  readonly onToggleSelectCard: (card: WorkCard) => void;
  /** The selection: how many cards are selected, and a way to empty it (Esc, last). */
  readonly selection: { readonly count: number; readonly clear: () => void };
  /**
   * The merge by key: `M` picks the card to merge, the arrows walk to the card
   * to merge it into, Return merges and Esc cancels. While a card is picked
   * no other key means anything.
   */
  readonly mergePick: MergePick;
  /** Opens Add to Work in the lane `laneId`: the lane of the current card, or its focused head. `undefined` when the keys have none. */
  readonly onAdd: (laneId: string | undefined) => void;
  /** The Add to Work sheet: whether it is open, and a way to close it. */
  readonly addSheet: { readonly isOpen: boolean; readonly close: () => void };
  /**
   * The Task's details sheet: whether it is open, a way to close it, and what
   * Return does on the card it is open for. `pressReturn` does what the sheet's
   * Return does for that card and returns `true`, or returns `false` for any
   * other card, which Return then opens.
   */
  readonly taskPane: {
    readonly isOpen: boolean;
    readonly close: () => void;
    readonly pressReturn: (card: WorkCard) => boolean;
  };
}

/** What `useBoardKeys` gives back to the screen. */
export interface BoardKeys {
  readonly isKeysSheetOpen: boolean;
  /** Opens the sheet of keys, as the `?` key does. */
  readonly showKeysSheet: () => void;
  /** The id of the Find match the arrow keys are on, or `null` when Find lists none. */
  readonly activeFindId: string | null;
  /** Takes the keys of the Find box: the arrows walk the matches, Return opens one, Esc clears the text. */
  readonly handleFindKeys: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}

/**
 * Listens to the keys of the Work board for as long as the screen is mounted,
 * and returns the state those keys leave on the screen: the keys sheet, and
 * which Find match is active. The keys are in `readBoardKey`.
 *
 * - A key is the board's only when focus is on the page itself or on
 *   something inside the board, and never in a text field, a menu, a dialog or
 *   the Add to Work sheet. Undo and Esc also work from the toolbar.
 * - The current card is the one under the pointer, until an arrow key takes
 *   over from the pointer, and then the card with focus. Every key that acts
 *   on a card or on its lane (the arrows, the stage keys, Return, A and F)
 *   uses that one card. While focus is on a lane's head there is no card with
 *   focus, so A and F act on that lane unless the pointer rests on a card.
 * - Esc steps back one thing at a time: the card picked to merge, the keys
 *   sheet, the Add to Work sheet, the details sheet, the Find text, the filter,
 *   then the selection. An open menu closes itself first.
 * - While a card is in the hand of a drag, no key does anything here.
 */
export const useBoardKeys = (input: BoardKeysInput): BoardKeys => {
  const { view, cards, arrangedLanes, findMatches, projects, moves, scrollRef, findRef } = input;
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
    // With the details open, walking to a card shows that Task's details.
    // While a card is picked to merge, walking only chooses the card to merge into.
    const card =
      input.taskPane.isOpen && input.mergePick.sourceId === null
        ? cards.find((each) => each.id === cardId)
        : undefined;
    if (card !== undefined) input.onOpenCard(card);
    return true;
  };

  /** Moves focus to the head button of the lane, which has no card to take it, and hands the keys over from the pointer. Returns whether the lane is on screen. */
  const focusLaneHead = (laneId: string): boolean => {
    const button = scrollRef.current?.querySelector<HTMLElement>(
      `[data-lane-head="${laneId}"] .board-lane-button`,
    );
    if (button === null || button === undefined) return false;
    hoveredCardId.current = null;
    button.focus();
    return true;
  };

  /** Folds or opens lanes with `change`, and keeps focus on the lane's head when the focused card folds away with it. */
  const changeFoldsKeepingFocus = (change: () => void, laneId: string | undefined): void => {
    const scroller = scrollRef.current;
    const hadFocusInBoard = scroller?.contains(document.activeElement) === true;
    change();
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
    const laneId = chooseLaneId(card, new Set(projects.map((project) => project.id)));
    const move: CardMove = { taskId: card.id, stage };
    // The move is committed before it returns: the card is a new element in
    // its new cell, and focus can only go to it once it is there.
    moves.moveCardWithMotion(move, describeCardMove(card, move, projects));
    if (!hadFocus || focusCard(card.id)) return;
    // The cell shows only some of its cards, and the moved one is behind its
    // line ("3 landed", "13 more"). Focus goes to that line.
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-more-cell-id="${buildCellId(laneId, stage)}"]`)
      ?.focus({ preventScroll: true });
  };

  const stepBack = (event: KeyboardEvent): void => {
    if (document.querySelector(OPEN_OVERLAY_SELECTOR) !== null) return;
    if (input.mergePick.sourceId !== null) {
      input.mergePick.cancel();
    } else if (isKeysSheetOpen) {
      setKeysSheetOpen(false);
    } else if (input.addSheet.isOpen) {
      input.addSheet.close();
    } else if (input.taskPane.isOpen) {
      input.taskPane.close();
    } else if (view.findText !== "") {
      view.setFindText("");
    } else if (isFilterOn(view.filter)) {
      view.setFilter(EMPTY_FILTER);
    } else if (input.selection.count > 0) {
      input.selection.clear();
    } else {
      return;
    }
    event.preventDefault();
  };

  const handleKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || input.isCarrying || isTextField(event.target)) return;
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

    const shownIds = new Set(listShownCardIds(arrangedLanes));
    const headLaneId = target?.closest<HTMLElement>("[data-lane-head]")?.dataset.laneHead;
    // The card under a resting pointer, else the one with focus. A lane's head
    // having focus means no card has it, whichever card had it last.
    const focusedId = headLaneId === undefined ? view.currentCardId : null;
    const currentId = [hoveredCardId.current, focusedId].find(
      (id) => id !== null && shownIds.has(id),
    );
    const currentCard = cards.find((card) => card.id === currentId);
    const currentLaneId =
      currentCard === undefined
        ? headLaneId
        : chooseLaneId(currentCard, new Set(projects.map((project) => project.id)));

    // While a card is picked to merge, only walking, Return and Esc mean anything.
    if (
      input.mergePick.sourceId !== null &&
      command.kind !== "walk" &&
      command.kind !== "open-card"
    ) {
      return;
    }

    switch (command.kind) {
      case "walk": {
        event.preventDefault();
        // A lane walk that starts on a lane head goes on from that lane.
        const isLaneWalk = command.walk === "previousLane" || command.walk === "nextLane";
        const from: WalkStop | undefined =
          currentCard === undefined || (isLaneWalk && headLaneId !== undefined)
            ? headLaneId === undefined
              ? undefined
              : { kind: "lane", laneId: headLaneId }
            : { kind: "card", cardId: currentCard.id };
        const next = walkBoard(arrangedLanes, from, command.walk);
        if (next?.kind === "card") focusCard(next.cardId);
        else if (next?.kind === "lane") focusLaneHead(next.laneId);
        return;
      }
      case "open-card":
        // On a button, Return and Space press that button. Only a card, or the page itself, is the board's.
        if (target !== document.body && target?.matches(".desk-card") !== true) return;
        if (currentCard === undefined) return;
        event.preventDefault();
        if (input.taskPane.pressReturn(currentCard)) return;
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
        input.onAdd(currentLaneId);
        return;
      case "end":
        if (currentCard === undefined) return;
        event.preventDefault();
        input.onEndCard(currentCard, command.stage);
        return;
      case "merge":
        if (currentCard === undefined) return;
        event.preventDefault();
        input.mergePick.start(currentCard);
        return;
      case "start-thread":
        if (currentCard === undefined) return;
        event.preventDefault();
        input.onStartThread(currentCard);
        return;
      case "select":
        if (currentCard === undefined) return;
        event.preventDefault();
        input.onToggleSelectCard(currentCard);
        return;
      case "fold-lane": {
        if (currentLaneId === undefined) return;
        event.preventDefault();
        changeFoldsKeepingFocus(() => {
          view.toggleLane(currentLaneId);
        }, currentLaneId);
        return;
      }
      case "fold-all-lanes":
        event.preventDefault();
        changeFoldsKeepingFocus(() => {
          view.foldEverything(arrangedLanes.map((each) => each.lane.id));
        }, currentLaneId);
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

  return {
    isKeysSheetOpen,
    showKeysSheet: () => {
      setKeysSheetOpen(true);
    },
    activeFindId,
    handleFindKeys,
  };
};
