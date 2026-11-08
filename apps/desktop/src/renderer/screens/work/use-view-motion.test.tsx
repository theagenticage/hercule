/**
 * Tests that opening and closing the rest of a cell, or a stack, keeps the
 * button that was pressed where it is on screen, by scrolling the board to
 * make up for the cards that appear or leave above it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useRef, useState, type JSX } from "react";
import { findBody } from "../../app/motion";
import { useViewMotion } from "./use-view-motion";
import type { WorkView } from "./use-work-view";

/** How far the button moves down while its cell is open: the height of the extra cards. */
const OPEN_CELL_HEIGHT = 1000;

/** A board of one lane with one cell. jsdom has no layout, so the rects below describe where each part sits. */
function Board(): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const view = {
    openedCellIds: new Set(isOpen ? ["lane/stage"] : []),
    foldedLaneIds: new Set<string>(),
    isFiltering: false,
    toggleCell: () => {
      setIsOpen((open) => !open);
    },
  } as unknown as WorkView;
  const { toggleCell } = useViewMotion(view, scrollRef);
  return (
    <div ref={scrollRef} data-testid="scroller">
      <section className="board-lane" data-lane-id="lane" data-open={isOpen}>
        <div className="board-cell" data-cell-id="lane/stage" data-stage="building">
          <button
            type="button"
            data-more-cell-id="lane/stage"
            onClick={() => {
              toggleCell("lane/stage");
            }}
          >
            {isOpen ? "Show fewer" : "13 more"}
          </button>
        </div>
      </section>
    </div>
  );
}

describe("useViewMotion toggleCell", () => {
  it.each(["opens", "closes"])("keeps the button still on screen when the cell %s", (action) => {
    const { getByTestId, container } = render(<Board />);
    const scroller = getByTestId("scroller");
    const lane = container.querySelector<HTMLElement>(".board-lane")!;
    const button = container.querySelector<HTMLElement>("button")!;
    const rect = (top: number): DOMRect => ({ top, bottom: top, height: 0 }) as DOMRect;
    // The lane's top never moves, but the button sits 1000px lower while the cell is open.
    lane.getBoundingClientRect = () => rect(100 - scroller.scrollTop);
    button.getBoundingClientRect = () =>
      rect(300 - scroller.scrollTop + (lane.dataset["open"] === "true" ? OPEN_CELL_HEIGHT : 0));
    if (action === "closes") {
      fireEvent.click(button);
      scroller.scrollTop = OPEN_CELL_HEIGHT;
    }
    const before = button.getBoundingClientRect().top;
    fireEvent.click(button);
    expect(button.getBoundingClientRect().top).toBe(before);
  });
});

/** The id of the stack in the board below. */
const STACK_ID = "lane/ticket";

/** A board of one lane with a stack. Pressing its sheet opens or closes the members. */
function StackBoard(): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const view = {
    openedStackIds: new Set(isOpen ? [STACK_ID] : []),
    foldedLaneIds: new Set<string>(),
    isFiltering: false,
    toggleStack: () => {
      setIsOpen((open) => !open);
    },
  } as unknown as WorkView;
  const { toggleStack } = useViewMotion(view, scrollRef);
  return (
    <div ref={scrollRef} data-testid="scroller">
      <section className="board-lane" data-lane-id="lane" data-open={isOpen}>
        <div className="board-cell" data-cell-id="lane/exploring" data-stage="exploring">
          <div className="board-stack" data-stack-lead="ticket">
            <div data-card-id="ticket" data-stage="exploring" />
            <button
              type="button"
              className="board-stack-bar"
              data-stack-bar={STACK_ID}
              onClick={() => {
                toggleStack(STACK_ID);
              }}
            >
              2 pull requests
            </button>
            {isOpen && (
              <div className="board-stack-members">
                <div data-card-id="pr-one" data-stage="exploring" />
                <div data-card-id="pr-two" data-stage="exploring" />
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

describe("useViewMotion toggleStack", () => {
  it.each(["opens", "closes"])("keeps the sheet still on screen when the stack %s", (action) => {
    const { getByTestId, container } = render(<StackBoard />);
    const scroller = getByTestId("scroller");
    const lane = container.querySelector<HTMLElement>(".board-lane")!;
    const sheet = container.querySelector<HTMLElement>(".board-stack-bar")!;
    const rect = (top: number): DOMRect => ({ top, bottom: top, height: 0 }) as DOMRect;
    // The lane's top never moves, but the sheet sits 400px lower while the stack is open.
    lane.getBoundingClientRect = () => rect(100 - scroller.scrollTop);
    sheet.getBoundingClientRect = () =>
      rect(300 - scroller.scrollTop + (lane.dataset["open"] === "true" ? 400 : 0));
    if (action === "closes") {
      fireEvent.click(sheet);
      scroller.scrollTop = 400;
    }
    const before = sheet.getBoundingClientRect().top;
    fireEvent.click(sheet);
    expect(sheet.getBoundingClientRect().top).toBe(before);
    expect(container.querySelectorAll(".board-stack-members")).toHaveLength(
      action === "opens" ? 1 : 0,
    );
  });
});

/** A board of one Initiative row, open or folded, and the block heading over it. */
function RowBoard({ calls }: { readonly calls: string[] }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isBlockFolded, setIsBlockFolded] = useState(false);
  const view = {
    openedInitiativeIds: new Set(isOpen ? ["platform"] : []),
    foldedLaneIds: new Set<string>(),
    isFiltering: false,
    toggleInitiativeRow: (initiativeId: string) => {
      calls.push(initiativeId);
      setIsOpen((open) => !open);
    },
    toggleInitiativeBlock: () => {
      setIsBlockFolded((folded) => !folded);
    },
  } as unknown as WorkView;
  const { toggleInitiativeRow, toggleInitiativeBlock } = useViewMotion(view, scrollRef);
  return (
    <div ref={scrollRef} data-testid="scroller">
      <button type="button" className="initiative-block-button" onClick={toggleInitiativeBlock}>
        Initiatives
      </button>
      {!isBlockFolded && (
        <section
          className={isOpen ? "initiative-row is-open" : "initiative-row"}
          data-lane-id="initiative-row:platform"
          data-open={isOpen}
        >
          <button
            type="button"
            className="initiative-toggle"
            onClick={() => {
              toggleInitiativeRow("platform");
            }}
          >
            Platform
          </button>
        </section>
      )}
    </div>
  );
}

describe("useViewMotion toggleInitiativeRow", () => {
  it("toggles the row of the Initiative through the view, and keeps the row still", () => {
    const calls: string[] = [];
    const { getByTestId, container } = render(<RowBoard calls={calls} />);
    const scroller = getByTestId("scroller");
    const row = container.querySelector<HTMLElement>(".initiative-row")!;
    const rect = (top: number): DOMRect => ({ top, bottom: top, height: 0 }) as DOMRect;
    // The row's top sits 500px lower while it is open, as if cards above it had grown.
    row.getBoundingClientRect = () =>
      rect(300 - scroller.scrollTop + (row.dataset["open"] === "true" ? 500 : 0));
    const before = row.getBoundingClientRect().top;

    fireEvent.click(container.querySelector(".initiative-toggle")!);

    expect(calls).toEqual(["platform"]);
    expect(row.className).toContain("is-open");
    expect(row.getBoundingClientRect().top).toBe(before);
  });

  it("folds and opens the block of rows as one change", () => {
    const { container } = render(<RowBoard calls={[]} />);
    const heading = container.querySelector(".initiative-block-button")!;

    fireEvent.click(heading);
    expect(container.querySelector(".initiative-row")).toBeNull();

    fireEvent.click(heading);
    expect(container.querySelector(".initiative-row")).not.toBeNull();
  });
});

/** A board of one Project lane with an open Initiative row under it (In lanes), whose card is in the row. */
function LaneWithRowBoard(): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isFolded, setIsFolded] = useState(false);
  const view = {
    foldedLaneIds: new Set(isFolded ? ["core"] : []),
    isFiltering: false,
    toggleLane: () => {
      setIsFolded((folded) => !folded);
    },
  } as unknown as WorkView;
  const { toggleLane } = useViewMotion(view, scrollRef);
  return (
    <div className="work-desk">
      <div ref={scrollRef} data-testid="scroller">
        <section className={isFolded ? "board-lane is-folded" : "board-lane"} data-lane-id="core">
          <button
            type="button"
            onClick={() => {
              toggleLane("core");
            }}
          >
            Core
          </button>
          {isFolded && (
            <div data-fold-row="core">
              <span data-stage="building" />
            </div>
          )}
        </section>
        {!isFolded && (
          <section
            className="initiative-row is-open"
            data-lane-id="initiative-row:platform"
            data-under-lane="core"
          >
            <div data-card-id="queue" data-stage="building" />
          </section>
        )}
      </div>
    </div>
  );
}

describe("useViewMotion toggleLane with an Initiative row under the lane", () => {
  beforeEach(() => {
    document.documentElement.style.setProperty("--dur-2", "200ms");
    // jsdom has no layout: every part is the same 40px strip, which is in view of the scroller.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 10, 100, 40),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.style.removeProperty("--dur-2");
  });

  it("flies the row's cards into the folded lane's count", () => {
    const { container } = render(<LaneWithRowBoard />);

    fireEvent.click(container.querySelector("button")!);

    // A flight with no target is removed at once, so a copy that stands has found the count.
    expect(container.querySelectorAll("[data-flight-card='queue']")).toHaveLength(1);
    expect(container.querySelector("[data-fold-row='core']")).not.toBeNull();
  });

  it("grows the row's cards out of the lane's count when the lane opens", () => {
    const { container } = render(<LaneWithRowBoard />);
    const toggle = container.querySelector("button")!;
    fireEvent.click(toggle);
    // Let the fold's copy go, so that the cards grow out of the count and not out of the copy.
    container.querySelector("[data-flight-card='queue']")?.remove();

    fireEvent.click(toggle);

    const card = container.querySelector<HTMLElement>("[data-card-id='queue']")!;
    expect(findBody(card)?.values.s).toBe(0.1);
  });

  it("starts the row's card from its copy still in flight when the lane opens again halfway", () => {
    const { container } = render(<LaneWithRowBoard />);
    const toggle = container.querySelector("button")!;
    fireEvent.click(toggle);

    fireEvent.click(toggle);

    const card = container.querySelector<HTMLElement>("[data-card-id='queue']")!;
    // The copy hands its place to the card: it is gone, and the card is solid where the copy was.
    expect(container.querySelector("[data-flight-card='queue']")).toBeNull();
    expect(findBody(card)?.values).toMatchObject({ s: 1, o: 1 });
  });
});
