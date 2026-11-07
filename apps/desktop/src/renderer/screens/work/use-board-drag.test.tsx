/**
 * Tests carrying a card as the user does it: pressing, moving the pointer,
 * letting go, and the ways a carry ends without a drop. The board is the real
 * one (`BoardDesk` and `BoardLane`); jsdom has no layout, so
 * `placeCardsOnScreen` gives every element a rectangle the way a browser
 * would after the slot moves. What needs a real browser (the springs, how the
 * ghost and the slot look, scrolling at the edges) is left to the end-to-end
 * test.
 */
import { useRef, useState, type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import {
  arrangeLanes,
  buildLanes,
  CARD_NOT_EXACT_NOTE,
  STAGE_NAMES,
  type CardMove,
} from "@hercule/client-core/work";
import { buildCard } from "@hercule/client-core/work/testing";
import { BOARD_STAGES, type BoardStage, type WorkCard } from "@hercule/contract";
import { findBody } from "../../app/motion/body";
import { BoardDesk } from "./board-desk";
import { BoardLane } from "./board-lane";
import { useBoardDrag } from "./use-board-drag";

const PROJECTS = [
  { id: "storefront", name: "Storefront" },
  { id: "warehouse", name: "Warehouse" },
];

/** The first lane: three cards in Exploring, one in Building. */
const STOREFRONT_CARDS: readonly WorkCard[] = [
  buildCard("refund-emails", { title: "Refund emails", projectId: "storefront" }),
  buildCard("delivery-slots", { title: "Delivery slots", projectId: "storefront" }),
  buildCard("gift-wrap", { title: "Gift wrap", projectId: "storefront" }),
  buildCard("promo-codes", { title: "Promo codes", projectId: "storefront", stage: "building" }),
];

const CARDS: readonly WorkCard[] = [
  ...STOREFRONT_CARDS,
  buildCard("pick-lists", { title: "Pick lists", projectId: "warehouse" }),
];

// ---------- A layout for jsdom ----------

const COLUMN_WIDTH = 140;
const CARD_HEIGHT = 90;
const CARD_GAP = 20;
const LANE_HEAD = 40;
const LANE_PADDING = 30;
const FOLDED_LANE_HEIGHT = 44;

/** The left edge of the column of `stage`. */
const columnLeft = (stage: BoardStage): number => 200 + 150 * BOARD_STAGES.indexOf(stage);

/** Returns how tall `element` is in the stubbed layout. A card in the hand takes no room. */
const readStubbedHeight = (element: HTMLElement): number => {
  if (element.dataset["dragged"] !== undefined) return 0;
  if (element.classList.contains("board-slot")) return Number.parseFloat(element.style.height);
  return element.dataset["cardId"] === undefined ? 0 : CARD_HEIGHT;
};

/** Returns the height of the stack of cards in `cell`. */
const stackHeight = (cell: Element): number => {
  const rows = [...cell.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement && readStubbedHeight(child) > 0,
  );
  return (
    rows.reduce((sum, row) => sum + readStubbedHeight(row), 0) +
    CARD_GAP * Math.max(0, rows.length - 1)
  );
};

/** Returns how tall a lane is: its head and its tallest cell, or one line when it is folded. */
const laneHeight = (lane: Element): number =>
  lane.classList.contains("is-folded")
    ? FOLDED_LANE_HEIGHT
    : LANE_HEAD +
      LANE_PADDING +
      Math.max(0, ...[...lane.querySelectorAll(".board-cell")].map(stackHeight));

/** Returns where a lane starts, below the lanes before it. */
const laneTop = (lane: Element): number => {
  let top = 0;
  for (
    let before = lane.previousElementSibling;
    before !== null;
    before = before.previousElementSibling
  ) {
    top += laneHeight(before);
  }
  return top;
};

/** Returns the rectangle the layout gives `element`, with the offset its body shows and the scroll of the board taken off, as a browser reports it. */
const layOut = (element: HTMLElement): DOMRect => {
  const offset = findBody(element)?.values ?? { x: 0, y: 0 };
  const scrolled = element.closest(".board-scroll")?.scrollTop ?? 0;
  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    new DOMRect(left + offset.x, top + offset.y - scrolled, width, height);
  const lane = element.closest(".board-lane");
  if (element.classList.contains("board-scroll")) return new DOMRect(0, 0, 1200, 800);
  if (element.classList.contains("board-stage")) {
    return rect(columnLeft(element.dataset["stage"] as BoardStage), 54, COLUMN_WIDTH, 32);
  }
  if (element.classList.contains("board-lane")) {
    return rect(0, laneTop(element), 1200, laneHeight(element));
  }
  const cell = element.closest(".board-cell");
  if (element.classList.contains("board-cell") && lane !== null) {
    return rect(
      columnLeft(element.dataset["stage"] as BoardStage),
      laneTop(lane) + LANE_HEAD,
      COLUMN_WIDTH,
      stackHeight(element),
    );
  }
  if (cell instanceof HTMLElement && lane !== null && readStubbedHeight(element) > 0) {
    let above = 0;
    for (
      let before = element.previousElementSibling;
      before !== null;
      before = before.previousElementSibling
    ) {
      const height = before instanceof HTMLElement ? readStubbedHeight(before) : 0;
      if (height > 0) above += height + CARD_GAP;
    }
    return rect(
      columnLeft(cell.dataset["stage"] as BoardStage),
      laneTop(lane) + LANE_HEAD + above,
      COLUMN_WIDTH,
      readStubbedHeight(element),
    );
  }
  return new DOMRect(0, 0, 0, 0);
};

// ---------- The board under test ----------

interface Harness {
  readonly moveCard: ReturnType<
    typeof vi.fn<(move: CardMove, words: string, note?: string) => void>
  >;
  readonly moveCards: ReturnType<
    typeof vi.fn<
      (
        moves: readonly CardMove[],
        describe: (moves: readonly CardMove[]) => string,
        note?: string,
      ) => void
    >
  >;
  readonly selectedIds: ReadonlySet<string>;
  readonly say: ReturnType<typeof vi.fn<(text: string) => void>>;
  readonly holdMerge: ReturnType<
    typeof vi.fn<(sourceCardId: string, targetCardId: string) => boolean>
  >;
  readonly onOpenCard: ReturnType<typeof vi.fn<(card: WorkCard) => void>>;
}

/** Renders the board as the Work screen does, with the drag hook on it. */
function Board({
  drawnCards,
  cards,
  foldedLaneIds,
  harness,
}: {
  /** The cards the board draws. */
  readonly drawnCards: readonly WorkCard[];
  /** The cards of the logical board, which the hook reads. They differ from the drawn ones while the screen holds changes back. */
  readonly cards: readonly WorkCard[];
  readonly foldedLaneIds: ReadonlySet<string>;
  readonly harness: Harness;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const arrangedLanes = arrangeLanes(buildLanes({ cards: drawnCards }, PROJECTS), {
    foldedLaneIds,
    openedCellIds: new Set(),
    isFiltering: false,
  });
  const [isCarrying, setIsCarrying] = useState(false);
  useBoardDrag({
    scrollRef,
    cards,
    projects: PROJECTS,
    arrangedLanes,
    selectedIds: harness.selectedIds,
    moveCard: harness.moveCard,
    moveCards: harness.moveCards,
    say: harness.say,
    holdMerge: harness.holdMerge,
    onCarryingChange: setIsCarrying,
  });
  return (
    <BoardDesk
      toolbar={null}
      overlays={null}
      stageCounts={null}
      laneLabels="side-labels"
      isOffline={false}
      isCarrying={isCarrying}
      hasSheet={false}
      isArriving={false}
      state="board"
      scrollRef={scrollRef}
    >
      <div className="board-lanes">
        {arrangedLanes.map((each) => (
          <BoardLane
            key={each.lane.id}
            arrangedLane={each}
            tabStopCardId={null}
            isStill
            canWriteSummaries={false}
            selectedIds={harness.selectedIds}
            onToggleLane={() => {}}
            onToggleCell={() => {}}
            onAddTask={() => {}}
            onPressCard={harness.onOpenCard}
            onFocusCard={() => {}}
          />
        ))}
      </div>
    </BoardDesk>
  );
}

/** Renders the board and returns what a test needs to drive it. */
const renderBoard = (
  cards: readonly WorkCard[] = CARDS,
  foldedLaneIds: ReadonlySet<string> = new Set(),
  selectedIds: ReadonlySet<string> = new Set(),
) => {
  const harness: Harness = {
    selectedIds,
    moveCard: vi.fn(),
    moveCards: vi.fn(),
    say: vi.fn(),
    holdMerge: vi.fn(() => true),
    onOpenCard: vi.fn(),
  };
  const view = render(
    <Board drawnCards={cards} cards={cards} foldedLaneIds={foldedLaneIds} harness={harness} />,
  );
  const scroller = view.container.querySelector<HTMLElement>(".board-scroll")!;
  return {
    moveCard: harness.moveCard,
    moveCards: harness.moveCards,
    say: harness.say,
    holdMerge: harness.holdMerge,
    onOpenCard: harness.onOpenCard,
    /** Whether the desk is marked as carrying a card, which is how the screen draws that a card is in the hand. */
    isCarrying: (): boolean =>
      view.container.querySelector(".work-desk")?.hasAttribute("data-carrying") === true,
    scroller,
    rerenderWith: (next: readonly WorkCard[], folded: ReadonlySet<string> = foldedLaneIds) => {
      view.rerender(
        <Board drawnCards={next} cards={next} foldedLaneIds={folded} harness={harness} />,
      );
    },
    /**
     * Changes the board as it is now while the board drawn stays as it is,
     * which is what a push does during a carry: the screen holds the changes
     * back until the card is let go.
     */
    changeBoardBehindCarry: (current: readonly WorkCard[]) => {
      view.rerender(
        <Board
          drawnCards={cards}
          cards={current}
          foldedLaneIds={foldedLaneIds}
          harness={harness}
        />,
      );
    },
    unmount: view.unmount,
    /** The element of a card in the page (the hidden one, while it is carried). */
    card: (id: string): HTMLElement =>
      view.container.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!,
    /** The copy in the hand, or `null` when no card is carried. */
    ghost: (): HTMLElement | null => document.querySelector<HTMLElement>(".board-carry .desk-card"),
    slot: (): HTMLElement | null => document.querySelector<HTMLElement>(".board-slot"),
    /** Returns the ids of the cards in a cell of a lane, top to bottom, with `slot` where the hollow is. */
    readCell: (laneId: string, stage: BoardStage): string[] =>
      [
        ...view.container.querySelectorAll<HTMLElement>(
          `.board-cell[data-lane-id="${laneId}"][data-stage="${stage}"] > *`,
        ),
      ]
        .filter((child) => child.dataset["dragged"] === undefined)
        .map((child) =>
          child.classList.contains("board-slot") ? "slot" : (child.dataset["cardId"] ?? "?"),
        ),
  };
};

/** The place in the window where the middle of `stage`'s column is, for a pointer. */
const columnX = (stage: BoardStage): number => columnLeft(stage) + 20;

/** Where the pointer is for a row `index` (0 is the top) of the first lane. */
const rowY = (index: number): number => LANE_HEAD + 20 + index * (CARD_HEIGHT + CARD_GAP);

/** Presses the primary button on `element` at (x, y). */
const press = (element: Element, x: number, y: number): void => {
  fireEvent.pointerDown(element, {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: x,
    clientY: y,
  });
};

/** Moves the pointer to (x, y). With capture on the board, a browser aims the event at it. */
const moveTo = (scroller: Element, x: number, y: number): void => {
  fireEvent.pointerMove(scroller, { pointerId: 1, isPrimary: true, clientX: x, clientY: y });
};

const release = (scroller: Element, x: number, y: number): void => {
  fireEvent.pointerUp(scroller, { pointerId: 1, isPrimary: true, clientX: x, clientY: y });
};

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return layOut(this);
  });
  // jsdom has no pointer capture. A held pointer is what a browser would hold.
  const held = new Set<number>();
  Element.prototype.setPointerCapture = (id: number) => void held.add(id);
  Element.prototype.releasePointerCapture = (id: number) => void held.delete(id);
  Element.prototype.hasPointerCapture = (id: number) => held.has(id);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  // The motion clock asks for one frame at a time. A test that stops with a frame still asked for on a fake clock
  // would leave the clock waiting for a frame that never comes, so the clock is played out first.
  if (vi.isFakeTimers()) vi.advanceTimersByTime(4000);
  vi.useRealTimers();
  document.documentElement.style.removeProperty("--dur-2");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("pressing a card", () => {
  it("stays a click below 5px: nothing lifts, nothing is sent, and the card still opens", () => {
    const board = renderBoard();
    const card = board.card("refund-emails");

    press(card, 220, 70);
    moveTo(board.scroller, 223, 73);
    release(board.scroller, 223, 73);
    fireEvent.click(card);

    expect(board.ghost()).toBeNull();
    expect(board.isCarrying()).toBe(false);
    expect(board.moveCard).not.toHaveBeenCalled();
    expect(board.onOpenCard).toHaveBeenCalledOnce();
  });

  it("lifts past 5px: a copy goes into the carry layer, the card hides, and a slot holds its place", () => {
    const board = renderBoard();
    const card = board.card("delivery-slots");

    press(card, 220, rowY(1));
    moveTo(board.scroller, 220, rowY(1) + 6);

    expect(board.isCarrying()).toBe(true);
    expect(board.ghost()?.textContent).toContain("Delivery slots");
    // The copy is not a second card for the keyboard, the screen reader or a lookup by id.
    expect(board.ghost()?.hasAttribute("data-card-id")).toBe(false);
    expect(board.ghost()?.hasAttribute("role")).toBe(false);
    expect(card.isConnected).toBe(true);
    expect(card.hasAttribute("data-dragged")).toBe(true);
    expect(board.readCell("storefront", "exploring")).toEqual([
      "refund-emails",
      "slot",
      "gift-wrap",
    ]);
  });

  it("holds the pointer on the board, never on a card, which React can replace", () => {
    const setPointerCapture = vi.spyOn(Element.prototype, "setPointerCapture");
    const board = renderBoard();

    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 80);

    expect(setPointerCapture).toHaveBeenCalledOnce();
    expect(setPointerCapture.mock.contexts[0]).toBe(board.scroller);
  });

  it("keeps the copy exactly under the pointer, one to one", () => {
    const board = renderBoard();
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 224, 76);
    moveTo(board.scroller, 500, 300);

    // The copy was laid out where the card stood, so its offset is how far the pointer went from the grab.
    const offset = findBody(board.ghost()!)!.values;
    expect(offset.x).toBe(500 - 224);
    expect(offset.y).toBe(300 - 76);
  });

  it("leans with the speed of the hand, by at most 1.2 degrees, and stands straight once the hand is still", () => {
    const board = renderBoard();
    document.documentElement.style.setProperty("--dur-2", "200ms");
    vi.useFakeTimers({
      toFake: [
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "performance",
        "setTimeout",
        "clearTimeout",
      ],
    });
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 76);

    // A fast sweep to the right: 400px in one frame. It ends in the gap below a card: resting over a
    // card's middle for a second would draw the two together, and the card in the hand would stay tilted.
    vi.advanceTimersByTime(16);
    moveTo(board.scroller, 620, 135);
    vi.advanceTimersByTime(48);
    const tilt = findBody(board.ghost()!)!.values.r;
    expect(tilt).toBeGreaterThan(0.2);
    expect(tilt).toBeLessThan(1.21);

    vi.advanceTimersByTime(1500);
    expect(Math.abs(findBody(board.ghost()!)!.values.r)).toBeLessThan(0.01);
  });

  it("ignores the secondary button", () => {
    const board = renderBoard();
    fireEvent.pointerDown(board.card("refund-emails"), {
      pointerId: 1,
      button: 2,
      isPrimary: true,
      clientX: 220,
      clientY: 70,
    });
    moveTo(board.scroller, 220, 120);
    expect(board.ghost()).toBeNull();
  });
});

describe("dropping a card", () => {
  it("calls moveCard once with the stage, the card to follow, and the words for the undo line, and no note", () => {
    const board = renderBoard();
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 76);
    // Below the middle of the one card in Building: after "Promo codes".
    moveTo(board.scroller, columnX("building"), rowY(0) + 40);
    expect(board.readCell("storefront", "building")).toEqual(["promo-codes", "slot"]);
    release(board.scroller, columnX("building"), rowY(0) + 40);

    expect(board.moveCard).toHaveBeenCalledExactlyOnceWith(
      { taskId: "refund-emails", stage: "building", afterTaskId: "promo-codes" },
      `Moved "Refund emails" to ${STAGE_NAMES.building}`,
      undefined,
    );
    expect(board.ghost()).toBeNull();
    expect(board.slot()).toBeNull();
    expect(board.card("refund-emails").hasAttribute("data-dragged")).toBe(false);
    expect(board.isCarrying()).toBe(false);
  });

  it("keeps a drop below the last row of a cell with a more line on that row, so the card stays in view", () => {
    const building = ["b1", "b2", "b3", "b4", "b5", "b6"].map((id) =>
      buildCard(id, { title: id, projectId: "storefront", stage: "building" }),
    );
    const board = renderBoard([...STOREFRONT_CARDS.slice(0, 3), ...building]);
    press(board.card("gift-wrap"), 220, rowY(2));
    moveTo(board.scroller, 220, rowY(2) + 6);
    moveTo(board.scroller, columnX("building"), rowY(3) + 80);

    // The last child is the more line, which has no card id.
    expect(board.readCell("storefront", "building")).toEqual(["b1", "b2", "b3", "slot", "b4", "?"]);
    release(board.scroller, columnX("building"), rowY(3) + 80);

    expect(board.moveCard.mock.calls[0]![0]).toEqual({
      taskId: "gift-wrap",
      stage: "building",
      afterTaskId: "b3",
    });
  });

  it("names the other lane's Project when the card is dropped in that lane", () => {
    const board = renderBoard();
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 76);
    // The Warehouse lane starts below the Storefront lane, which is as tall as its three-card cell.
    const warehouseY = 40 + 30 + 3 * 90 + 2 * 20 + 40 + 20;
    moveTo(board.scroller, columnX("exploring"), warehouseY);
    release(board.scroller, columnX("exploring"), warehouseY);

    expect(board.moveCard.mock.calls[0]![0]).toMatchObject({
      taskId: "refund-emails",
      stage: "exploring",
      projectId: "warehouse",
    });
  });

  it("moves to a folded lane's Project with no place in the column, since a folded lane holds no slot", () => {
    const board = renderBoard(CARDS, new Set(["warehouse"]));
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 76);
    const foldedLaneY = laneTop(board.scroller.querySelector('[data-lane-id="warehouse"]')!) + 20;
    moveTo(board.scroller, columnX("planned"), foldedLaneY);
    expect(board.slot()).toBeNull();
    expect(
      board.scroller.querySelector('[data-lane-id="warehouse"]')!.hasAttribute("data-drop-target"),
    ).toBe(true);
    release(board.scroller, columnX("planned"), foldedLaneY);

    expect(board.moveCard.mock.calls[0]![0]).toEqual({
      taskId: "refund-emails",
      stage: "planned",
      projectId: "warehouse",
    });
  });

  describe("when a push changed the board during the carry", () => {
    const WITH_SECOND_BUILDING = [
      ...CARDS,
      buildCard("stock-sync", { title: "Stock sync", projectId: "storefront", stage: "building" }),
    ];

    /** Carries "Refund emails" to Building, between "Promo codes" and "Stock sync". */
    const carryBetweenBuildingCards = (board: ReturnType<typeof renderBoard>): void => {
      press(board.card("refund-emails"), 220, 70);
      moveTo(board.scroller, 220, 76);
      moveTo(board.scroller, columnX("building"), rowY(0) + 60);
      expect(board.readCell("storefront", "building")).toEqual([
        "promo-codes",
        "slot",
        "stock-sync",
      ]);
    };

    it("puts the card last in its cell, and says so, when the card it follows has left the board", () => {
      const board = renderBoard(WITH_SECOND_BUILDING);
      carryBetweenBuildingCards(board);
      board.changeBoardBehindCarry(
        WITH_SECOND_BUILDING.filter((card) => card.id !== "promo-codes"),
      );
      release(board.scroller, columnX("building"), rowY(0) + 60);

      expect(board.moveCard).toHaveBeenCalledExactlyOnceWith(
        { taskId: "refund-emails", stage: "building", afterTaskId: "stock-sync" },
        `Moved "Refund emails" to ${STAGE_NAMES.building}`,
        CARD_NOT_EXACT_NOTE,
      );
    });

    it("sends nothing, and says why, when the Task has left the board", () => {
      const board = renderBoard(WITH_SECOND_BUILDING);
      carryBetweenBuildingCards(board);
      board.changeBoardBehindCarry(
        WITH_SECOND_BUILDING.filter((card) => card.id !== "refund-emails"),
      );
      release(board.scroller, columnX("building"), rowY(0) + 60);

      expect(board.moveCard).not.toHaveBeenCalled();
      expect(board.say).toHaveBeenCalledExactlyOnceWith(
        "The Task has left the board, so it was not moved.",
      );
      expect(board.isCarrying()).toBe(false);
      expect(board.slot()).toBeNull();
    });

    it("sends the move as it is, with no note, when the card it follows is still there", () => {
      const board = renderBoard(WITH_SECOND_BUILDING);
      carryBetweenBuildingCards(board);
      board.changeBoardBehindCarry(WITH_SECOND_BUILDING.filter((card) => card.id !== "pick-lists"));
      release(board.scroller, columnX("building"), rowY(0) + 60);

      expect(board.moveCard.mock.calls[0]![0]).toEqual({
        taskId: "refund-emails",
        stage: "building",
        afterTaskId: "promo-codes",
      });
      expect(board.moveCard.mock.calls[0]![2]).toBeUndefined();
      expect(board.say).not.toHaveBeenCalled();
    });
  });

  it("swallows the click that follows a carry, so the card does not open", () => {
    const board = renderBoard();
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 90);
    release(board.scroller, 220, 90);
    fireEvent.click(board.card("refund-emails"));

    expect(board.onOpenCard).not.toHaveBeenCalled();
  });
});

describe("a carry that ends without a drop", () => {
  /** Lifts the first card and moves it to Building, where a slot opens. */
  const carryToBuilding = (board: ReturnType<typeof renderBoard>): void => {
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 76);
    moveTo(board.scroller, columnX("building"), rowY(0) + 40);
    expect(board.slot()).not.toBeNull();
  };

  /** Checks that the card is home: shown in its own place, with no copy, no slot, and nothing sent. */
  const expectHome = (board: ReturnType<typeof renderBoard>): void => {
    expect(board.moveCard).not.toHaveBeenCalled();
    expect(board.ghost()).toBeNull();
    expect(board.slot()).toBeNull();
    expect(board.card("refund-emails").hasAttribute("data-dragged")).toBe(false);
    expect(board.readCell("storefront", "exploring")).toEqual([
      "refund-emails",
      "delivery-slots",
      "gift-wrap",
    ]);
    expect(board.isCarrying()).toBe(false);
  };

  it("goes home on Esc, and Esc reaches nothing else", () => {
    const board = renderBoard();
    const otherEscapeHandler = vi.fn();
    window.addEventListener("keydown", otherEscapeHandler);
    carryToBuilding(board);

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(escape);
    window.removeEventListener("keydown", otherEscapeHandler);

    expectHome(board);
    expect(escape.defaultPrevented).toBe(true);
    expect(otherEscapeHandler).not.toHaveBeenCalled();
  });

  it("does not open the card when the button is let go over it, however long after Esc", async () => {
    const board = renderBoard();
    carryToBuilding(board);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    release(board.scroller, 220, 70);
    fireEvent.click(board.card("refund-emails"));

    expect(board.onOpenCard).not.toHaveBeenCalled();
  });

  it("goes home when the system cancels the pointer", () => {
    const board = renderBoard();
    carryToBuilding(board);
    fireEvent.pointerCancel(board.scroller, { pointerId: 1, isPrimary: true });
    expectHome(board);
  });

  it("goes home when the board loses the pointer other than by letting it go", () => {
    const board = renderBoard();
    carryToBuilding(board);
    fireEvent(board.scroller, new PointerEvent("lostpointercapture", { pointerId: 1 }));
    expectHome(board);
  });

  it("goes home when the window is hidden", () => {
    const board = renderBoard();
    carryToBuilding(board);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expectHome(board);
  });

  it("goes home when the window loses the focus, because the release may never arrive", () => {
    const board = renderBoard();
    carryToBuilding(board);
    fireEvent.blur(window);
    expectHome(board);
  });

  it("is cleaned up at once when the screen unmounts in the middle of a carry", () => {
    const board = renderBoard();
    carryToBuilding(board);
    board.unmount();

    expect(document.querySelector(".board-carry")).toBeNull();
    expect(board.slot()).toBeNull();
    expect(board.moveCard).not.toHaveBeenCalled();
  });

  it("goes home when a live push removes the card in the hand", async () => {
    const board = renderBoard();
    carryToBuilding(board);

    board.rerenderWith(CARDS.filter((card) => card.id !== "refund-emails"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(board.moveCard).not.toHaveBeenCalled();
    expect(board.slot()).toBeNull();
    expect(board.isCarrying()).toBe(false);
    // The card has no place on the page to land in, so the copy fades out where it is.
    await waitFor(() => {
      expect(board.ghost()).toBeNull();
    });
  });

  it("goes home when a live push moves the card in the hand to another cell", async () => {
    const board = renderBoard();
    carryToBuilding(board);

    board.rerenderWith(
      CARDS.map((card) =>
        card.id === "refund-emails" ? { ...card, stage: "planned" as const } : card,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(board.moveCard).not.toHaveBeenCalled();
    expect(board.ghost()).toBeNull();
    expect(board.slot()).toBeNull();
    // The card reappears where the push put it, not hidden.
    expect(board.card("refund-emails").hasAttribute("data-dragged")).toBe(false);
  });

  it("goes home when a live push removes the lane the slot is in", async () => {
    const board = renderBoard();
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 76);
    const warehouseY = 40 + 30 + 3 * 90 + 2 * 20 + 40 + 20;
    moveTo(board.scroller, columnX("exploring"), warehouseY);
    expect(board.slot()).not.toBeNull();

    board.rerenderWith(CARDS.filter((card) => card.projectId !== "warehouse"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(board.moveCard).not.toHaveBeenCalled();
    expect(board.ghost()).toBeNull();
    expect(board.isCarrying()).toBe(false);
  });

  it("goes home when a live push folds the lane the slot is in", async () => {
    const board = renderBoard();
    carryToBuilding(board);

    board.rerenderWith(CARDS, new Set(["storefront"]));
    await act(async () => {
      await Promise.resolve();
    });

    expect(board.moveCard).not.toHaveBeenCalled();
    expect(board.isCarrying()).toBe(false);
    // The whole lane is folded, so the card has no place on the page to land in.
    await waitFor(() => {
      expect(board.ghost()).toBeNull();
    });
  });
});

describe("merging by holding a carried card over another", () => {
  /** Where the pointer is over the middle of the second card of the first lane's Exploring column. */
  const MIDDLE_OF_DELIVERY_SLOTS = { x: 270, y: 195 } as const;

  /** Fakes the clock the wait for the merge and the springs run on. */
  const useFakeClock = (): void => {
    vi.useFakeTimers({
      toFake: [
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "performance",
        "setTimeout",
        "clearTimeout",
      ],
    });
  };

  /** Lifts the first card and brings it over the middle of the second, where the wait for a merge starts. */
  const carryOverDeliverySlots = (board: ReturnType<typeof renderBoard>): void => {
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 76);
    moveTo(board.scroller, MIDDLE_OF_DELIVERY_SLOTS.x, MIDDLE_OF_DELIVERY_SLOTS.y);
  };

  /** Moves the pointer with Option held. */
  const moveWithOption = (scroller: Element, x: number, y: number): void => {
    fireEvent.pointerMove(scroller, {
      pointerId: 1,
      isPrimary: true,
      clientX: x,
      clientY: y,
      altKey: true,
    });
  };

  /** Returns whether the card is drawn as the one to merge into. */
  const isTarget = (card: HTMLElement): boolean => card.hasAttribute("data-merge-target");

  it("makes the card the target once the pointer has rested over its middle for one second", () => {
    useFakeClock();
    const board = renderBoard();
    carryOverDeliverySlots(board);
    const target = board.card("delivery-slots");

    vi.advanceTimersByTime(999);
    expect(isTarget(target)).toBe(false);
    vi.advanceTimersByTime(1);

    expect(isTarget(target)).toBe(true);
    expect(target.dataset["mergeLabel"]).toBe("Merge into Delivery slots");
    expect(target.dataset["mergeKeeps"]).toBe("Keeps its title, stage and place");
    // The slot closes but keeps its room, so nothing jumps.
    expect(board.slot()?.classList.contains("is-shut")).toBe(true);

    // The target swells to 1.02, and the card in the hand docks on its corner, smaller and tilted.
    vi.advanceTimersByTime(800);
    expect(findBody(target)!.values.s).toBeCloseTo(1.02, 2);
    const hand = findBody(board.ghost()!)!.values;
    expect(hand.s).toBeCloseTo(0.96, 2);
    expect(hand.r).toBeCloseTo(1.6, 1);
    expect(hand.x).toBeGreaterThan(8);
    expect(hand.x).toBeLessThan(13);
    expect(hand.y).toBeGreaterThan(115);
    expect(hand.y).toBeLessThan(122);
  });

  it("starts the wait again when the pointer moves more than 6px, and keeps it for 6px or less", () => {
    useFakeClock();
    const board = renderBoard();
    carryOverDeliverySlots(board);
    const target = board.card("delivery-slots");

    vi.advanceTimersByTime(600);
    moveTo(board.scroller, MIDDLE_OF_DELIVERY_SLOTS.x + 6, MIDDLE_OF_DELIVERY_SLOTS.y);
    vi.advanceTimersByTime(400);
    expect(isTarget(target)).toBe(true);
  });

  it("does not choose a card for a pointer that moved more than 6px since it began to rest", () => {
    useFakeClock();
    const board = renderBoard();
    carryOverDeliverySlots(board);
    const target = board.card("delivery-slots");

    vi.advanceTimersByTime(600);
    moveTo(board.scroller, MIDDLE_OF_DELIVERY_SLOTS.x + 7, MIDDLE_OF_DELIVERY_SLOTS.y);
    vi.advanceTimersByTime(600);
    expect(isTarget(target)).toBe(false);
    vi.advanceTimersByTime(400);
    expect(isTarget(target)).toBe(true);
  });

  it("chooses the card at once when Option is held, and when Option goes down over a resting pointer", () => {
    useFakeClock();
    const board = renderBoard();
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 76);
    moveWithOption(board.scroller, MIDDLE_OF_DELIVERY_SLOTS.x, MIDDLE_OF_DELIVERY_SLOTS.y);
    expect(isTarget(board.card("delivery-slots"))).toBe(true);

    // Away from every card, and back with the pointer still and Option pressed afterwards.
    moveTo(board.scroller, 220, 76);
    expect(isTarget(board.card("delivery-slots"))).toBe(false);
    moveTo(board.scroller, MIDDLE_OF_DELIVERY_SLOTS.x, MIDDLE_OF_DELIVERY_SLOTS.y);
    expect(isTarget(board.card("delivery-slots"))).toBe(false);
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    expect(isTarget(board.card("delivery-slots"))).toBe(true);
  });

  it("starts no wait over the top or the bottom of a card, only over its middle 40%", () => {
    useFakeClock();
    const board = renderBoard();
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 76);
    // The second card spans 150 to 240: its top 30% ends at 177, its bottom 30% starts at 213.
    moveTo(board.scroller, 270, 170);
    vi.advanceTimersByTime(1500);
    expect(isTarget(board.card("delivery-slots"))).toBe(false);
    moveTo(board.scroller, 270, 220);
    vi.advanceTimersByTime(1500);
    expect(isTarget(board.card("delivery-slots"))).toBe(false);
  });

  it("undoes it all at once when the pointer leaves the middle of the target", () => {
    useFakeClock();
    const board = renderBoard();
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 76);
    moveWithOption(board.scroller, MIDDLE_OF_DELIVERY_SLOTS.x, MIDDLE_OF_DELIVERY_SLOTS.y);
    vi.advanceTimersByTime(500);

    moveTo(board.scroller, 270, 225);

    const target = board.card("delivery-slots");
    expect(isTarget(target)).toBe(false);
    expect(target.hasAttribute("data-merge-label")).toBe(false);
    expect(board.slot()?.classList.contains("is-shut")).toBe(false);
    vi.advanceTimersByTime(1500);
    // The card in the hand is back under the pointer, at its size.
    const hand = findBody(board.ghost()!)!.values;
    expect(hand.s).toBeCloseTo(1.03, 2);
    expect(hand.x).toBeCloseTo(270 - 20 - 200 + 0, -1);
  });

  it("holds the merge when the card is let go over the target, and moves nothing", () => {
    useFakeClock();
    const board = renderBoard();
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 76);
    moveWithOption(board.scroller, MIDDLE_OF_DELIVERY_SLOTS.x, MIDDLE_OF_DELIVERY_SLOTS.y);
    vi.advanceTimersByTime(300);

    release(board.scroller, MIDDLE_OF_DELIVERY_SLOTS.x, MIDDLE_OF_DELIVERY_SLOTS.y);

    expect(board.holdMerge).toHaveBeenCalledExactlyOnceWith("refund-emails", "delivery-slots");
    expect(board.moveCard).not.toHaveBeenCalled();
    expect(board.isCarrying()).toBe(false);
    expect(board.slot()).toBeNull();
    expect(board.card("refund-emails").hasAttribute("data-dragged")).toBe(false);
    expect(isTarget(board.card("delivery-slots"))).toBe(false);
    // The copy slides in under the cards of the board, as the card is not a card to the keyboard, and then goes.
    const under = board.scroller.querySelector(".board-canvas > .board-merge-under .desk-card");
    expect(under?.textContent).toContain("Refund emails");
    expect(under?.hasAttribute("data-card-id")).toBe(false);
    expect(board.ghost()).toBeNull();
    vi.advanceTimersByTime(3000);
    expect(board.scroller.querySelector(".board-merge-under")).toBeNull();
  });

  it("says nothing was merged, and sends the card home, when a card left the board meanwhile", () => {
    useFakeClock();
    const board = renderBoard();
    board.holdMerge.mockReturnValue(false);
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 76);
    moveWithOption(board.scroller, MIDDLE_OF_DELIVERY_SLOTS.x, MIDDLE_OF_DELIVERY_SLOTS.y);

    release(board.scroller, MIDDLE_OF_DELIVERY_SLOTS.x, MIDDLE_OF_DELIVERY_SLOTS.y);

    expect(board.say).toHaveBeenCalledExactlyOnceWith(
      "A card left the board, so nothing was merged.",
    );
    expect(board.moveCard).not.toHaveBeenCalled();
    expect(board.card("refund-emails").hasAttribute("data-dragged")).toBe(false);
  });

  it("merges nothing when the card is let go before the wait is over", () => {
    useFakeClock();
    const board = renderBoard();
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 76);
    // The middle of the one card in Building, reached from another cell.
    moveTo(board.scroller, columnX("building"), 85);
    vi.advanceTimersByTime(900);

    release(board.scroller, columnX("building"), 85);

    expect(board.holdMerge).not.toHaveBeenCalled();
    expect(board.moveCard).toHaveBeenCalledOnce();
  });

  it("sends the card home on Esc, and merges nothing", () => {
    useFakeClock();
    const board = renderBoard();
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 76);
    moveWithOption(board.scroller, MIDDLE_OF_DELIVERY_SLOTS.x, MIDDLE_OF_DELIVERY_SLOTS.y);
    expect(isTarget(board.card("delivery-slots"))).toBe(true);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(isTarget(board.card("delivery-slots"))).toBe(false);
    expect(board.holdMerge).not.toHaveBeenCalled();
    expect(board.ghost()).toBeNull();
    expect(board.card("refund-emails").hasAttribute("data-dragged")).toBe(false);
  });
});

describe("a board that scrolls under a carried card", () => {
  /** Makes the board report that it is scrolled `top` pixels, and tells it so as a browser does. */
  const scrollTo = (scroller: HTMLElement, top: number): void => {
    Object.defineProperty(scroller, "scrollTop", {
      value: top,
      configurable: true,
      writable: true,
    });
    fireEvent.scroll(scroller);
  };

  it("moves the slot to the row that came under the pointer, and reads the page only for that move", () => {
    const board = renderBoard();
    press(board.card("gift-wrap"), 220, rowY(2));
    moveTo(board.scroller, 220, rowY(2) + 6);
    moveTo(board.scroller, columnX("exploring"), rowY(0) - 10);
    expect(board.readCell("storefront", "exploring")).toEqual([
      "slot",
      "refund-emails",
      "delivery-slots",
    ]);
    // The layout stub is already a spy: forget what it counted until now.
    const reads = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    reads.mockClear();

    // A pointer that stays over the same place reads nothing, and neither does a scroll that keeps it there.
    moveTo(board.scroller, columnX("exploring"), rowY(0) - 12);
    scrollTo(board.scroller, 10);
    expect(reads).not.toHaveBeenCalled();
    expect(board.readCell("storefront", "exploring")[0]).toBe("slot");

    // A scroll by three rows puts the pointer under both cards, so the slot goes after them.
    scrollTo(board.scroller, 3 * (CARD_HEIGHT + CARD_GAP));
    expect(board.readCell("storefront", "exploring")).toEqual([
      "refund-emails",
      "delivery-slots",
      "slot",
    ]);
  });
});

describe("carrying several selected cards", () => {
  /** The cards selected in these tests: the first of the lane, one at the bottom of its column, and one in Building. */
  const SELECTED = new Set(["refund-emails", "gift-wrap", "promo-codes"]);

  /** Fakes the clock the springs run on, so a test can play them out. */
  const useFakeClock = (): void => {
    // Motion runs unless the page asks for none.
    document.documentElement.style.setProperty("--dur-2", "200ms");
    vi.useFakeTimers({
      toFake: [
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "performance",
        "setTimeout",
        "clearTimeout",
      ],
    });
  };

  /** Lifts the first card of the lane, which is selected with two others, and moves it to (x, y). */
  const carrySelection = (board: ReturnType<typeof renderBoard>, x: number, y: number): void => {
    press(board.card("refund-emails"), 220, 70);
    moveTo(board.scroller, 220, 76);
    moveTo(board.scroller, x, y);
  };

  const followers = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>(".board-carry .desk-card.is-follower"),
  ];

  it("picks up the other selected cards in board order, hides them in the page, and counts all of them on the first", () => {
    const board = renderBoard(CARDS, new Set(), SELECTED);

    carrySelection(board, 500, 300);

    expect(followers().map((each) => each.textContent)).toEqual([
      expect.stringContaining("Gift wrap"),
      expect.stringContaining("Promo codes"),
    ]);
    // The copies are not cards for the keyboard, the screen reader or a lookup by id.
    expect(followers().every((each) => !each.hasAttribute("data-card-id"))).toBe(true);
    expect(board.ghost()?.classList.contains("has-followers")).toBe(true);
    expect(board.ghost()?.dataset["count"]).toBe("3");
    expect(board.card("gift-wrap").hasAttribute("data-dragged")).toBe(true);
    expect(board.card("promo-codes").hasAttribute("data-dragged")).toBe(true);
    // Cards not selected stay where they are.
    expect(board.card("delivery-slots").hasAttribute("data-dragged")).toBe(false);
  });

  it("stacks them behind the first, each 5px further and 2% smaller, one behind the other", () => {
    useFakeClock();
    const board = renderBoard(CARDS, new Set(), SELECTED);
    carrySelection(board, 500, 300);
    vi.advanceTimersByTime(3000);

    // The first card was lifted when the pointer was 20px across and 36px down from its corner,
    // so its corner is at (480, 264). Gift wrap stood at (200, 260) and Promo codes at (500, 40).
    const [giftWrap, promoCodes] = followers().map((each) => findBody(each)!.values);
    expect(giftWrap).toMatchObject({ x: 480 + 5 - 200, y: 264 + 5 - 260 });
    expect(giftWrap!.s).toBeCloseTo(0.98, 3);
    expect(promoCodes).toMatchObject({ x: 480 + 10 - 500, y: 264 + 10 - 40 });
    expect(promoCodes!.s).toBeCloseTo(0.96, 3);
    expect(followers().map((each) => each.style.zIndex)).toEqual(["-1", "-2"]);
  });

  it("carries only the pressed card when it is not selected", () => {
    const board = renderBoard(CARDS, new Set(), SELECTED);

    press(board.card("delivery-slots"), 220, rowY(1));
    moveTo(board.scroller, 220, rowY(1) + 6);

    expect(followers()).toEqual([]);
    expect(board.ghost()?.hasAttribute("data-count")).toBe(false);
    expect(board.card("gift-wrap").hasAttribute("data-dragged")).toBe(false);
  });

  it("sends one gesture for all of them on release, the first card first, each following the one before", () => {
    const board = renderBoard(CARDS, new Set(), SELECTED);
    // The pointer is in the empty cell of Planned.
    carrySelection(board, columnX("planned"), rowY(0) + 20);
    expect(board.slot()).not.toBeNull();

    release(board.scroller, columnX("planned"), rowY(0) + 20);

    expect(board.moveCard).not.toHaveBeenCalled();
    expect(board.moveCards).toHaveBeenCalledOnce();
    const [moves, describe, note] = board.moveCards.mock.calls[0]!;
    expect(moves).toEqual([
      { taskId: "refund-emails", stage: "planned", afterTaskId: null },
      { taskId: "gift-wrap", stage: "planned", afterTaskId: "refund-emails" },
      { taskId: "promo-codes", stage: "planned", afterTaskId: "gift-wrap" },
    ]);
    expect(describe(moves)).toBe(`Moved 3 Tasks to ${STAGE_NAMES.planned}`);
    expect(note).toBeUndefined();
    // Nothing of the carry is left in the page.
    expect(board.slot()).toBeNull();
    expect(board.card("gift-wrap").hasAttribute("data-dragged")).toBe(false);
    expect(board.card("promo-codes").hasAttribute("data-dragged")).toBe(false);
    expect(board.isCarrying()).toBe(false);
  });

  it("names a single card when the others left the board during the carry", () => {
    const board = renderBoard(CARDS, new Set(), SELECTED);
    carrySelection(board, columnX("planned"), rowY(0) + 20);
    board.changeBoardBehindCarry(
      CARDS.filter((card) => card.id !== "gift-wrap" && card.id !== "promo-codes"),
    );

    release(board.scroller, columnX("planned"), rowY(0) + 20);

    const [moves, describe, note] = board.moveCards.mock.calls[0]!;
    expect(moves).toEqual([{ taskId: "refund-emails", stage: "planned", afterTaskId: null }]);
    expect(describe(moves)).toBe(`Moved "Refund emails" to ${STAGE_NAMES.planned}`);
    expect(note).toBe("2 of the selected Tasks had left the board, so they were not moved.");
  });

  it("sends them all home on Esc, and sends nothing", () => {
    const board = renderBoard(CARDS, new Set(), SELECTED);
    carrySelection(board, columnX("planned"), rowY(0) + 20);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(board.moveCard).not.toHaveBeenCalled();
    expect(board.moveCards).not.toHaveBeenCalled();
    expect(board.ghost()).toBeNull();
    expect(followers()).toEqual([]);
    expect(board.card("gift-wrap").hasAttribute("data-dragged")).toBe(false);
    expect(board.card("promo-codes").hasAttribute("data-dragged")).toBe(false);
    expect(board.readCell("storefront", "exploring")).toEqual([
      "refund-emails",
      "delivery-slots",
      "gift-wrap",
    ]);
  });

  it("lands each card 40ms after the one before it", () => {
    useFakeClock();
    const board = renderBoard(CARDS, new Set(), SELECTED);
    carrySelection(board, columnX("planned"), rowY(0) + 20);
    vi.advanceTimersByTime(1000);

    release(board.scroller, columnX("planned"), rowY(0) + 20);

    // Each copy is replaced at once by the card, which stays where the copy was until its turn.
    expect(followers()).toEqual([]);
    const speedAt = (id: string): number => {
      const { x, y } = findBody(board.card(id))!.velocity;
      return Math.hypot(x, y);
    };
    vi.advanceTimersByTime(20);
    expect(speedAt("refund-emails")).toBeGreaterThan(0);
    expect(speedAt("gift-wrap")).toBe(0);
    expect(speedAt("promo-codes")).toBe(0);
    vi.advanceTimersByTime(40);
    expect(speedAt("gift-wrap")).toBeGreaterThan(0);
    expect(speedAt("promo-codes")).toBe(0);
    vi.advanceTimersByTime(40);
    expect(speedAt("promo-codes")).toBeGreaterThan(0);
  });

  it("merges nothing: holding the hand over a card, or Option, draws no merge", () => {
    useFakeClock();
    const board = renderBoard(CARDS, new Set(), SELECTED);
    // The middle of the second card of the lane's Exploring column.
    carrySelection(board, 270, 195);
    vi.advanceTimersByTime(1500);
    fireEvent.pointerMove(board.scroller, {
      pointerId: 1,
      isPrimary: true,
      clientX: 270,
      clientY: 195,
      altKey: true,
    });

    expect(board.card("delivery-slots").hasAttribute("data-merge-target")).toBe(false);

    release(board.scroller, 270, 195);
    expect(board.holdMerge).not.toHaveBeenCalled();
    expect(board.moveCards).toHaveBeenCalledOnce();
  });
});
