/**
 * Tests sliding a bead along a folded Initiative line as the user does it:
 * pressing, moving the pointer, letting go, and the keys. The board is the
 * real frame (`BoardDesk`) with a real `InitiativeRow`; jsdom has no layout,
 * so `layOut` gives the stage names and the beads the rectangles a browser
 * would. The springs, and how the bead looks, are left to the end-to-end test.
 */
import { useRef, useState, type JSX } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import {
  applyCardMove,
  arrangeLanes,
  groupBoardByProject,
  type CardMove,
} from "@hercule/client-core/work";
import { buildBoard, buildCard } from "@hercule/client-core/work/testing";
import { BOARD_STAGES, type BoardStage, type WorkCard } from "@hercule/contract";
import { findBody } from "../../app/motion/body";
import { BoardDesk } from "./board-desk";
import { InitiativeRow } from "./initiative-row";
import { useBeadSlide } from "./use-bead-slide";

const INITIATIVES = [
  { id: "platform", name: "Retire the scheduler", hue: 245, projectId: "core" },
] as const;
const PROJECTS = [{ id: "core", name: "Core" }];

const CARDS: readonly WorkCard[] = [
  buildCard("queue", { title: "Queue", initiativeId: "platform", projectId: "core" }),
  buildCard("workers", {
    title: "Workers",
    initiativeId: "platform",
    projectId: "core",
    stage: "building",
  }),
];

// ---------- A layout for jsdom ----------

const COLUMN_WIDTH = 140;
const BEAD_SIZE = 9;
const BEAD_GAP = 14;

/** The left edge of the column of `stage`. */
const columnLeft = (stage: BoardStage): number => 200 + 150 * BOARD_STAGES.indexOf(stage);

/** Returns the rectangle the layout gives `element`, with the offset its body shows, as a browser reports it. */
const layOut = (element: HTMLElement): DOMRect => {
  const offset = findBody(element)?.values ?? { x: 0, y: 0 };
  if (element.classList.contains("board-scroll")) return new DOMRect(0, 0, 1200, 800);
  if (element.classList.contains("board-stage")) {
    return new DOMRect(columnLeft(element.dataset["stage"] as BoardStage), 54, COLUMN_WIDTH, 32);
  }
  if (element.dataset["foldRow"] !== undefined) return new DOMRect(200, 100, 900, 22);
  if (element.dataset["beadTaskId"] !== undefined) {
    const cell = element.closest<HTMLElement>("[data-stage]")!;
    const index = [...cell.querySelectorAll("[data-bead-task-id]")].indexOf(element);
    return new DOMRect(
      columnLeft(cell.dataset["stage"] as BoardStage) + index * BEAD_GAP + offset.x,
      105 + offset.y,
      BEAD_SIZE,
      BEAD_SIZE,
    );
  }
  return new DOMRect(0, 0, 0, 0);
};

// ---------- The board under test ----------

interface Harness {
  readonly moveCard: ReturnType<typeof vi.fn<(move: CardMove, words: string) => void>>;
  readonly onPressBead: ReturnType<typeof vi.fn<(taskId: string) => void>>;
  readonly onCarryingChange: ReturnType<typeof vi.fn<(isCarrying: boolean) => void>>;
  /** What each render of the board drew: whether a bead was in the hand, and the stage of the Task "queue". */
  readonly drawn: { readonly isCarrying: boolean; readonly queueStage: BoardStage }[];
}

/** Renders a folded row of an Initiative with the slide hook on its board, and applies each move the hook sends. */
function Board({ harness }: { readonly harness: Harness }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [cards, setCards] = useState(CARDS);
  const [isCarrying, setIsCarrying] = useState(false);
  harness.drawn.push({
    isCarrying,
    queueStage: cards.find((each) => each.id === "queue")!.stage,
  });
  const lanes = groupBoardByProject({ cards, initiativeDoneCounts: {} }, PROJECTS, INITIATIVES, {
    place: "top",
    isFiltering: false,
  });
  const arranged = arrangeLanes(lanes, {
    foldedLaneIds: new Set(),
    openedCellIds: new Set(),
    openedInitiativeIds: new Set(),
    openedStackIds: new Set(),
    stackCandidates: [],
    isFiltering: false,
  }).find((each) => each.lane.initiative?.isRow === true)!;
  useBeadSlide({
    scrollRef,
    cards,
    projects: PROJECTS,
    initiatives: INITIATIVES,
    isCarrying,
    onCarryingChange: (isCarryingNow) => {
      harness.onCarryingChange(isCarryingNow);
      setIsCarrying(isCarryingNow);
    },
    moveCard: (move, words) => {
      harness.moveCard(move, words);
      // The screen commits the move at once, as it does for every move.
      flushSync(() => {
        setCards(applyCardMove(buildBoard(...cards), move).cards);
      });
    },
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
      <InitiativeRow
        arrangedLane={arranged}
        facts={null}
        plugins={[]}
        tabStop={null}
        isStill
        canWriteSummaries={false}
        selectedIds={new Set()}
        onToggleRow={() => {}}
        onEditInitiative={() => {}}
        onPressBead={harness.onPressBead}
        onToggleCell={() => {}}
        onToggleStack={() => {}}
        onPressCard={() => {}}
        onFocusCard={() => {}}
      />
    </BoardDesk>
  );
}

const renderBoard = () => {
  const harness: Harness = {
    moveCard: vi.fn(),
    onPressBead: vi.fn(),
    onCarryingChange: vi.fn(),
    drawn: [],
  };
  const view = render(<Board harness={harness} />);
  const scroller = view.container.querySelector<HTMLElement>(".board-scroll")!;
  return {
    ...harness,
    scroller,
    unmount: view.unmount,
    /** Whether the board is drawn with something in the hand. */
    isCarrying: (): boolean => view.container.querySelector("[data-carrying]") !== null,
    bead: (taskId: string): HTMLElement =>
      view.container.querySelector<HTMLElement>(`[data-bead-task-id="${taskId}"]`)!,
    /** The stage whose cell of the line holds the bead of `taskId`. */
    stageOf: (taskId: string): string | undefined =>
      view.container
        .querySelector<HTMLElement>(`[data-bead-task-id="${taskId}"]`)
        ?.closest<HTMLElement>("[data-stage]")?.dataset["stage"],
  };
};

/** Presses the primary button on `element` at x. */
const press = (element: Element, x: number): void => {
  fireEvent.pointerDown(element, {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: x,
    clientY: 110,
  });
};

const moveTo = (scroller: Element, x: number): void => {
  fireEvent.pointerMove(scroller, { pointerId: 1, isPrimary: true, clientX: x, clientY: 110 });
};

const release = (scroller: Element, x: number): void => {
  fireEvent.pointerUp(scroller, { pointerId: 1, isPrimary: true, clientX: x, clientY: 110 });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sliding a bead", () => {
  it("follows the pointer at 1.5 times its size while it is held", () => {
    const board = renderBoard();
    const queue = board.bead("queue");
    press(queue, columnLeft("exploring") + 4);

    moveTo(board.scroller, columnLeft("exploring") + 64);

    expect(queue.dataset["held"]).toBeDefined();
    expect(findBody(queue)!.values).toMatchObject({ x: 60, s: 1.5 });
  });

  it("sends a stage-only move to the stage under the pointer, and the bead is in that stage's cell", () => {
    const board = renderBoard();
    press(board.bead("queue"), columnLeft("exploring") + 4);
    moveTo(board.scroller, columnLeft("building") + 20);

    release(board.scroller, columnLeft("building") + 20);

    expect(board.moveCard).toHaveBeenCalledTimes(1);
    expect(board.moveCard.mock.calls[0]![0]).toEqual({ taskId: "queue", stage: "building" });
    expect(board.stageOf("queue")).toBe("building");
    expect(board.bead("queue").dataset["held"]).toBeUndefined();
  });

  it("does not open the Task for the click that ends a slide", () => {
    const board = renderBoard();
    const queue = board.bead("queue");
    press(queue, columnLeft("exploring") + 4);
    moveTo(board.scroller, columnLeft("building") + 20);
    release(board.scroller, columnLeft("building") + 20);

    fireEvent.click(board.bead("queue"));

    expect(board.onPressBead).not.toHaveBeenCalled();
  });

  it("sends nothing and brings the bead home when it is let go over its own stage", () => {
    const board = renderBoard();
    const queue = board.bead("queue");
    press(queue, columnLeft("exploring") + 4);
    moveTo(board.scroller, columnLeft("exploring") + 80);

    release(board.scroller, columnLeft("exploring") + 80);

    expect(board.moveCard).not.toHaveBeenCalled();
    expect(queue.dataset["held"]).toBeUndefined();
    expect(findBody(queue)!.values).toMatchObject({ x: 0, s: 1 });
  });

  it("treats a press that does not move as a click, which opens the Task", () => {
    const board = renderBoard();
    const queue = board.bead("queue");

    press(queue, columnLeft("exploring") + 4);
    moveTo(board.scroller, columnLeft("exploring") + 6);
    release(board.scroller, columnLeft("exploring") + 6);
    fireEvent.click(queue);

    expect(board.moveCard).not.toHaveBeenCalled();
    expect(queue.dataset["held"]).toBeUndefined();
    expect(board.onPressBead).toHaveBeenCalledExactlyOnceWith("queue");
  });

  it("sends the bead home on Esc and sends nothing", () => {
    const board = renderBoard();
    const queue = board.bead("queue");
    press(queue, columnLeft("exploring") + 4);
    moveTo(board.scroller, columnLeft("building") + 20);

    fireEvent.keyDown(document.body, { key: "Escape" });
    release(board.scroller, columnLeft("building") + 20);

    expect(board.moveCard).not.toHaveBeenCalled();
    expect(queue.dataset["held"]).toBeUndefined();
    expect(board.stageOf("queue")).toBe("exploring");
  });
});

describe("a bead in the hand", () => {
  it("is told to the screen when it is lifted, and the board is drawn as carrying", () => {
    const board = renderBoard();

    press(board.bead("queue"), columnLeft("exploring") + 4);
    expect(board.isCarrying()).toBe(false);
    moveTo(board.scroller, columnLeft("exploring") + 64);

    expect(board.isCarrying()).toBe(true);
  });

  it("lets go in the same draw as the move it sends, never before it", () => {
    const board = renderBoard();
    press(board.bead("queue"), columnLeft("exploring") + 4);
    moveTo(board.scroller, columnLeft("building") + 20);
    board.drawn.length = 0;

    release(board.scroller, columnLeft("building") + 20);

    expect(board.isCarrying()).toBe(false);
    expect(board.drawn).toEqual([{ isCarrying: false, queueStage: "building" }]);
  });

  it("lets go when the bead is let go over its own stage, and when it is sent home with Esc", () => {
    const board = renderBoard();
    press(board.bead("queue"), columnLeft("exploring") + 4);
    moveTo(board.scroller, columnLeft("exploring") + 80);
    release(board.scroller, columnLeft("exploring") + 80);
    expect(board.isCarrying()).toBe(false);

    press(board.bead("queue"), columnLeft("exploring") + 4);
    moveTo(board.scroller, columnLeft("building") + 20);
    expect(board.isCarrying()).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(board.isCarrying()).toBe(false);
  });

  it("does not take the bead out of the hand when a press only clicks", () => {
    const board = renderBoard();

    press(board.bead("queue"), columnLeft("exploring") + 4);
    moveTo(board.scroller, columnLeft("exploring") + 6);

    expect(board.isCarrying()).toBe(false);
  });

  it("lets go when the screen goes away with the bead in the hand", () => {
    const board = renderBoard();
    press(board.bead("queue"), columnLeft("exploring") + 4);
    moveTo(board.scroller, columnLeft("exploring") + 64);

    board.unmount();

    expect(board.onCarryingChange.mock.calls.map(([isCarrying]) => isCarrying)).toEqual([
      true,
      false,
    ]);
  });
});

describe("moving a bead by key", () => {
  it("moves the Task a stage right with Shift and the right arrow, and keeps focus on its bead", () => {
    const board = renderBoard();
    board.bead("queue").focus();

    fireEvent.keyDown(board.bead("queue"), { key: "ArrowRight", shiftKey: true });

    expect(board.moveCard.mock.calls[0]![0]).toEqual({ taskId: "queue", stage: "planned" });
    expect(board.stageOf("queue")).toBe("planned");
    expect(document.activeElement).toBe(board.bead("queue"));
  });

  it("moves the Task a stage left with Shift and the left arrow", () => {
    const board = renderBoard();
    board.bead("workers").focus();

    fireEvent.keyDown(board.bead("workers"), { key: "ArrowLeft", shiftKey: true });

    expect(board.moveCard.mock.calls[0]![0]).toEqual({ taskId: "workers", stage: "planned" });
  });

  it("sends nothing at the first stage, and the arrow alone only walks the beads", () => {
    const board = renderBoard();
    board.bead("queue").focus();

    fireEvent.keyDown(board.bead("queue"), { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(board.bead("queue"), { key: "ArrowRight" });

    expect(board.moveCard).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(board.bead("workers"));
  });
});
