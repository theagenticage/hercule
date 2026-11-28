/**
 * Tests what `useBoardReads` draws and when it measures the board: a read is
 * drawn right after its render, a user's own move is drawn in its render, and
 * nothing that nobody caused is drawn while a card is in the hand. The wait
 * for a still hand is replaced by one the test ends when it chooses, so a held
 * change can be released during a carry: that the wait itself refuses to end
 * during a drag is tested in `app/motion/still-hand.test.ts`, and the screen
 * as a whole in `work.integration.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useRef, type JSX } from "react";
import { buildBoardSnapshot, PROJECT_FACET_ID } from "@hercule/client-core/work";
import { buildBoard, buildCard, FAILURE } from "@hercule/client-core/work/testing";
import type { WorkBoard } from "@hercule/contract";
import { writeSavedBoardSnapshot } from "./board-snapshot-storage";
import { useBoardReads } from "./use-board-reads";

const SNAPSHOT_KEY = "work-board-snapshot:http://controller.test:noa";

/** Ends the waits that have started, in the order they started. */
const endWaits: (() => void)[] = [];

vi.mock("../../app/motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/motion")>()),
  waitForVisibleStillHand: vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        endWaits.push(() => {
          resolve(true);
        });
      }),
  ),
}));

/**
 * Draws a card element per card the hook returns, so a test can see what is
 * drawn. `serverBoard` is the board as read, `board` the logical board (that
 * board with the user's changes applied), `hiddenIds` the Tasks the logical
 * board left out on purpose, and `unrelated` is a prop the hook does not use.
 */
const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

function Harness({
  board,
  serverBoard = board,
  hiddenIds = NOTHING_HIDDEN,
  movedIds = NOTHING_HIDDEN,
  isCarrying = false,
}: {
  readonly board: WorkBoard;
  readonly serverBoard?: WorkBoard;
  readonly hiddenIds?: ReadonlySet<string>;
  readonly movedIds?: ReadonlySet<string>;
  readonly isCarrying?: boolean;
  readonly unrelated?: number;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const reads = useBoardReads({
    logicalBoard: board,
    hiddenIds,
    movedIds,
    serverBoard,
    snapshotKey: SNAPSHOT_KEY,
    projects: [],
    groupBy: PROJECT_FACET_ID,
    isCarrying,
    scrollRef,
  });
  return (
    <div className="work-desk">
      <div ref={scrollRef} className="board-scroll">
        <div className="board-cell" data-cell-id="no-project/exploring">
          {reads.drawnBoard?.cards.map((card) => (
            <div
              key={card.id}
              className="desk-card"
              data-card-id={card.id}
              data-stage={card.stage}
              data-failed={card.failure === undefined ? undefined : ""}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const findCard = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-card-id="${id}"]`);

/** Returns the ids of the cards drawn, top to bottom. */
const listDrawnIds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>("[data-card-id]")].map(
    (card) => card.dataset["cardId"] ?? "",
  );

/** Lets the microtasks that React and the hook queued run. */
const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

afterEach(() => {
  localStorage.clear();
  endWaits.length = 0;
  vi.restoreAllMocks();
});

describe("a read", () => {
  it("is drawn right after its render, and the board is measured only then", async () => {
    const before = buildBoard(buildCard("a"), buildCard("b"));
    const { rerender } = render(<Harness board={before} />);
    const measure = vi.spyOn(Element.prototype, "getBoundingClientRect");

    // A render that reads nothing new measures nothing.
    rerender(<Harness board={before} unrelated={1} />);
    await settle();
    expect(measure).not.toHaveBeenCalled();

    const after = buildBoard(buildCard("b"), buildCard("a"));
    rerender(<Harness board={after} />);
    expect(listDrawnIds()).toEqual(["a", "b"]);
    await settle();

    expect(listDrawnIds()).toEqual(["b", "a"]);
    expect(measure).toHaveBeenCalled();
  });

  it("is not measured when it changes nothing that is drawn", async () => {
    const before = buildBoard(buildCard("a"), buildCard("b"));
    const { rerender } = render(<Harness board={before} />);
    const measure = vi.spyOn(Element.prototype, "getBoundingClientRect");

    rerender(<Harness board={buildBoard(buildCard("a"), buildCard("b"))} />);
    await settle();

    expect(measure).not.toHaveBeenCalled();
  });
});

describe("a move the user made", () => {
  it("is drawn in its own render, not after it", () => {
    const server = buildBoard(buildCard("a"), buildCard("b"));
    const { rerender } = render(<Harness board={server} />);

    rerender(<Harness board={buildBoard(buildCard("b"), buildCard("a"))} serverBoard={server} />);

    expect(listDrawnIds()).toEqual(["b", "a"]);
  });
});

describe("a card the user's own gesture hid", () => {
  it("is drawn in its own render when it comes back, not held back as a Task that arrived", () => {
    const server = buildBoard(buildCard("a"), buildCard("b"));
    const merged = buildBoard(buildCard("a"));
    const { rerender } = render(<Harness board={server} />);

    // A merge held for the undo line hides "b".
    rerender(<Harness board={merged} serverBoard={server} hiddenIds={new Set(["b"])} />);
    expect(listDrawnIds()).toEqual(["a"]);

    // Undo takes the merge back.
    rerender(<Harness board={server} />);

    expect(listDrawnIds()).toEqual(["a", "b"]);
    expect(endWaits).toHaveLength(0);
  });
});

describe("a read while a card is in the hand", () => {
  it("is drawn with the drop, in the same render as the move the drop sends", async () => {
    const server = buildBoard(buildCard("a"), buildCard("b"), buildCard("c"));
    const { rerender } = render(<Harness board={server} />);
    rerender(<Harness board={server} isCarrying />);

    const read = buildBoard(buildCard("a"), buildCard("c"), buildCard("b"));
    rerender(<Harness board={read} serverBoard={read} isCarrying />);
    await settle();
    expect(listDrawnIds()).toEqual(["a", "b", "c"]);

    // The drop: the card leaves the hand and its move shows, with the read.
    const dropped = buildBoard(buildCard("c"), buildCard("a"), buildCard("b"));
    rerender(<Harness board={dropped} serverBoard={read} />);

    expect(listDrawnIds()).toEqual(["c", "a", "b"]);
  });

  it("draws a held change that was released during the carry only after the drop", async () => {
    const before = buildBoard(buildCard("a"), buildCard("b"));
    const failed = buildBoard(buildCard("a"), buildCard("b", { failure: FAILURE }));
    const { rerender } = render(<Harness board={before} />);
    rerender(<Harness board={failed} />);
    expect(endWaits).toHaveLength(1);
    rerender(<Harness board={failed} isCarrying />);

    await act(async () => {
      endWaits[0]!();
      await Promise.resolve();
    });
    expect(findCard("b")!.hasAttribute("data-failed")).toBe(false);

    rerender(<Harness board={failed} />);
    expect(findCard("b")!.hasAttribute("data-failed")).toBe(true);
  });
});

describe("the morning replay", () => {
  // A page with no stylesheet counts as Reduce motion, which plays no replay.
  beforeEach(() => {
    document.documentElement.style.setProperty("--dur-2", "200ms");
  });
  afterEach(() => {
    document.documentElement.style.removeProperty("--dur-2");
  });

  it("starts from the snapshot's stage, and leaves a card the user moves where the user put it", async () => {
    const left = buildBoard(buildCard("a", { stage: "in-review" }), buildCard("b"));
    const read = buildBoard(
      buildCard("a", { stage: "landed", stageChangedAt: "2026-11-03T03:00:00.000Z" }),
      buildCard("b"),
    );
    writeSavedBoardSnapshot(SNAPSHOT_KEY, buildBoardSnapshot(left));
    const { rerender } = render(<Harness board={read} />);
    expect(findCard("a")!.dataset["stage"]).toBe("in-review");

    // The user drags the card, which is drawn in Review, on to Building. The controller has not
    // answered, so the card still has the time of the move that the replay plays.
    const dragged = buildBoard(
      buildCard("a", { stage: "building", stageChangedAt: "2026-11-03T03:00:00.000Z" }),
      buildCard("b"),
    );
    rerender(<Harness board={dragged} serverBoard={read} movedIds={new Set(["a"])} />);
    await settle();

    expect(findCard("a")!.dataset["stage"]).toBe("building");
  });

  it("holds the card back at its snapshot stage without that move", async () => {
    const left = buildBoard(buildCard("a", { stage: "in-review" }), buildCard("b"));
    const read = buildBoard(
      buildCard("a", { stage: "landed", stageChangedAt: "2026-11-03T03:00:00.000Z" }),
      buildCard("b"),
    );
    writeSavedBoardSnapshot(SNAPSHOT_KEY, buildBoardSnapshot(left));
    const { rerender } = render(<Harness board={read} />);

    rerender(<Harness board={read} unrelated={1} />);
    await settle();

    expect(findCard("a")!.dataset["stage"]).toBe("in-review");
  });
});
