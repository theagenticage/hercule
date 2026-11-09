/**
 * Tests carrying a card onto a folded Initiative row: the line is the drop
 * target, the drop names the stage under the pointer and the Initiative, and
 * the card's bead is there afterwards. The board is the real one
 * (`BoardBody`); jsdom has no layout, so `layOut` gives every part the
 * rectangle a browser would.
 */
import { useRef, useState, type JSX } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { applyCardMove, type CardMove } from "@hercule/client-core/work";
import { arrangeTestBoard, buildBoard, buildCard } from "@hercule/client-core/work/testing";
import { BOARD_STAGES, type BoardStage, type WorkCard } from "@hercule/contract";
import { findBody } from "../../app/motion/body";
import { BoardBody } from "./board-body";
import { BoardDesk } from "./board-desk";
import { useBoardDrag } from "./use-board-drag";

const INITIATIVES = [
  { id: "platform", name: "Retire the scheduler", hue: 245, projectId: "core" },
] as const;
const PROJECTS = [{ id: "core", name: "Core" }];

const CARDS: readonly WorkCard[] = [
  buildCard("refund", { title: "Refund emails", projectId: "core" }),
  buildCard("queue", {
    title: "Queue",
    projectId: "core",
    initiativeId: "platform",
    stage: "building",
  }),
];

// ---------- A layout for jsdom ----------

const COLUMN_WIDTH = 140;
const CARD_HEIGHT = 90;
const ROW_TOP = 100;
const ROW_HEIGHT = 34;
const LANE_TOP = 200;

/** The left edge of the column of `stage`. */
const columnLeft = (stage: BoardStage): number => 200 + 150 * BOARD_STAGES.indexOf(stage);

/** Returns the rectangle the layout gives `element`, with the offset its body shows, as a browser reports it. */
const layOut = (element: HTMLElement): DOMRect => {
  const offset = findBody(element)?.values ?? { x: 0, y: 0 };
  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    new DOMRect(left + offset.x, top + offset.y, width, height);
  if (element.classList.contains("board-scroll")) return new DOMRect(0, 0, 1200, 800);
  if (element.classList.contains("board-stage")) {
    return rect(columnLeft(element.dataset["stage"] as BoardStage), 54, COLUMN_WIDTH, 32);
  }
  if (element.classList.contains("initiative-row")) return rect(0, ROW_TOP, 1200, ROW_HEIGHT);
  if (element.classList.contains("board-lane")) return rect(0, LANE_TOP, 1200, 300);
  if (element.dataset["beadTaskId"] !== undefined) {
    const cell = element.closest<HTMLElement>("[data-stage]")!;
    return rect(columnLeft(cell.dataset["stage"] as BoardStage), ROW_TOP + 12, 9, 9);
  }
  if (element.dataset["cardId"] !== undefined) {
    const cell = element.closest<HTMLElement>(".board-cell")!;
    const index = [...cell.children].indexOf(element);
    return rect(
      columnLeft(cell.dataset["stage"] as BoardStage),
      LANE_TOP + 40 + index * (CARD_HEIGHT + 20),
      COLUMN_WIDTH,
      CARD_HEIGHT,
    );
  }
  return new DOMRect(0, 0, 0, 0);
};

// ---------- The board under test ----------

interface Harness {
  readonly moveCard: ReturnType<typeof vi.fn<(move: CardMove, words: string) => void>>;
}

/** Renders the board as the Work screen does, and applies each move the drag sends. */
function Board({ harness }: { readonly harness: Harness }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [cards, setCards] = useState(CARDS);
  const arrangement = arrangeTestBoard(buildBoard(...cards), {
    projects: PROJECTS,
    initiatives: INITIATIVES,
    place: "lanes",
  });
  useBoardDrag({
    scrollRef,
    cards,
    projects: PROJECTS,
    initiatives: INITIATIVES,
    arrangedLanes: arrangement.drawnLanes,
    selectedIds: new Set(),
    moveCard: (move, words) => {
      harness.moveCard(move, words);
      flushSync(() => {
        setCards(applyCardMove(buildBoard(...cards), move).cards);
      });
    },
    moveCards: () => {},
    say: () => {},
    settleMerge: () => true,
    checkMerge: () => Promise.resolve({ kind: "allowed" }),
    onCarryingChange: () => {},
  });
  return (
    <BoardDesk
      toolbar={null}
      overlays={null}
      stageCounts={null}
      laneLabels="side-labels"
      isOffline={false}
      isCarrying={false}
      hasSheet={false}
      isArriving={false}
      state="board"
      scrollRef={scrollRef}
    >
      <BoardBody
        arrangement={arrangement}
        plugins={[]}
        initiativeFlags={undefined}
        tabStop={null}
        isStill
        canWriteSummaries={false}
        selectedIds={new Set()}
        onToggleBlock={() => {}}
        onToggleFold={() => {}}
        onEditInitiative={() => {}}
        onPressBead={() => {}}
        onToggleCell={() => {}}
        onToggleStack={() => {}}
        onAddTask={() => {}}
        onPressCard={() => {}}
        onFocusCard={() => {}}
      />
    </BoardDesk>
  );
}

const renderBoard = () => {
  const harness: Harness = { moveCard: vi.fn() };
  const view = render(<Board harness={harness} />);
  return {
    ...harness,
    scroller: view.container.querySelector<HTMLElement>(".board-scroll")!,
    card: (id: string): HTMLElement =>
      view.container.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!,
    row: (): HTMLElement => view.container.querySelector<HTMLElement>(".initiative-row")!,
    bead: (taskId: string): HTMLElement | null =>
      view.container.querySelector<HTMLElement>(`[data-bead-task-id="${taskId}"]`),
  };
};

/** Carries "Refund emails" over the pointer position (x, y) on the row's line, without letting go. */
const carryOver = (board: ReturnType<typeof renderBoard>, x: number): void => {
  fireEvent.pointerDown(board.card("refund"), {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: columnLeft("exploring") + 20,
    clientY: LANE_TOP + 60,
  });
  for (const [pointerX, pointerY] of [
    [columnLeft("exploring") + 20, LANE_TOP + 70],
    [x, ROW_TOP + 17],
  ] as const) {
    fireEvent.pointerMove(board.scroller, {
      pointerId: 1,
      isPrimary: true,
      clientX: pointerX,
      clientY: pointerY,
    });
  }
};

const release = (board: ReturnType<typeof renderBoard>, x: number): void => {
  fireEvent.pointerUp(board.scroller, {
    pointerId: 1,
    isPrimary: true,
    clientX: x,
    clientY: ROW_TOP + 17,
  });
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
  // A drop leaves a 50 ms guard on the window that swallows the next click (`swallowNextClick`). The
  // last test's guard would fire after the test environment is torn down and throw there, so a press
  // ends it now.
  window.dispatchEvent(new Event("pointerdown"));
  // Unmounts first: a card still in the hand is put down on the page's real layout, not on the
  // test's, and no window listener of this test's drag outlives it into the next test.
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("carrying a card onto a folded Initiative row", () => {
  it("marks the row as the target while the card is over its line, and not once it leaves", () => {
    const board = renderBoard();

    carryOver(board, columnLeft("planned") + 20);
    expect(board.row().hasAttribute("data-drop-target")).toBe(true);

    fireEvent.pointerMove(board.scroller, {
      pointerId: 1,
      isPrimary: true,
      clientX: columnLeft("planned") + 20,
      clientY: LANE_TOP + 100,
    });
    expect(board.row().hasAttribute("data-drop-target")).toBe(false);
  });

  it("sends the stage under the pointer and the Initiative, and the card's bead is in that stage afterwards", () => {
    const board = renderBoard();
    carryOver(board, columnLeft("planned") + 20);

    release(board, columnLeft("planned") + 20);

    expect(board.moveCard.mock.calls[0]![0]).toEqual({
      taskId: "refund",
      stage: "planned",
      initiativeId: "platform",
    });
    expect(board.bead("refund")?.closest<HTMLElement>("[data-stage]")?.dataset["stage"]).toBe(
      "planned",
    );
  });

  it("joins the Initiative and keeps the stage when the pointer is left of the stages", () => {
    const board = renderBoard();
    carryOver(board, 100);

    release(board, 100);

    expect(board.moveCard.mock.calls[0]![0]).toEqual({
      taskId: "refund",
      initiativeId: "platform",
    });
    expect(board.bead("refund")).not.toBeNull();
  });
});
