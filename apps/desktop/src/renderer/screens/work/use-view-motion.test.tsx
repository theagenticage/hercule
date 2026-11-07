/**
 * Tests that opening and closing the rest of a cell, or a stack, keeps the
 * button that was pressed where it is on screen, by scrolling the board to
 * make up for the cards that appear or leave above it.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useRef, useState, type JSX } from "react";
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
