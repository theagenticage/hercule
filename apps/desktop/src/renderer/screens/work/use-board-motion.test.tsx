/**
 * Tests what the Work board does with a read that brings an arrival or a
 * failure, with a fake clock: the change waits for a still hand and never
 * more than eight seconds, a Task that lies past the shown rows moves
 * nothing, and the toolbar's line says what happened.
 *
 * jsdom has no layout, so these tests check what is drawn and what the motion
 * kernel was asked to do, not where pixels land. The glide itself is checked
 * in `app/motion/motion.test.ts`, and by eye in the real app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect, useRef, type JSX } from "react";
import { buildBoard, buildCard, FAILURE } from "@hercule/client-core/work/testing";
import type { WorkBoard } from "@hercule/contract";
import { useBoardMotion, type BoardMotion } from "./use-board-motion";
import { useWorkView } from "./use-work-view";

/** How many cards a cell shows before "N more". */
const SHOWN_ROWS = 4;

/** Where the harness hands out what the hook returned, after each render. */
const probe: { current: BoardMotion | null } = { current: null };

/** Draws the cards a cell would show, as the screen does, from the board the hook returns. */
function Harness({ board }: { readonly board: WorkBoard }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const view = useWorkView("test-board-motion");
  const motion = useBoardMotion({ board, serverBoard: board, view, scrollRef });
  useEffect(() => {
    probe.current = motion;
  });
  const cards = motion.board?.cards ?? [];
  return (
    <div className="work-desk">
      <div ref={scrollRef} className="board-scroll">
        <section className="board-lane" data-lane-id="no-project">
          <div
            className="board-cell"
            data-cell-id="no-project/exploring"
            data-lane-id="no-project"
            data-stage="exploring"
          >
            {cards.slice(0, SHOWN_ROWS).map((card) => (
              <div
                key={card.id}
                className="desk-card"
                data-card-id={card.id}
                data-stage={card.stage}
                data-failed={card.failure === undefined ? undefined : ""}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

const cardsOf = (...ids: string[]) => ids.map((id) => buildCard(id, { title: `Task ${id}` }));

/** Finds the element of the card with this id. */
const findCard = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-card-id="${id}"]`);

/** Makes the pointer rest over `element` until the test lets go, as `:hover` says. */
const hover = (element: HTMLElement) => {
  const state = { isOver: true };
  const matches = element.matches.bind(element);
  vi.spyOn(element, "matches").mockImplementation((selector) =>
    selector === ":hover" ? state.isOver : matches(selector),
  );
  return state;
};

/** Lets `ms` milliseconds pass and React finish what they started. */
const pass = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  // A page with a duration token is a page without Reduce motion.
  document.documentElement.style.setProperty("--dur-2", "200ms");
});
afterEach(() => {
  probe.current = null;
  vi.useRealTimers();
  document.documentElement.style.removeProperty("--dur-2");
  localStorage.clear();
});

describe("a run that fails", () => {
  const before = buildBoard(...cardsOf("a", "b"));
  const failed = buildBoard(buildCard("a"), buildCard("b", { failure: FAILURE }));

  it("does not rise under a pointer resting on the card, and rises when eight seconds are over", async () => {
    const { rerender } = render(<Harness board={before} />);
    hover(findCard("b")!);

    rerender(<Harness board={failed} />);
    await pass(7_000);
    expect(findCard("b")!.hasAttribute("data-failed")).toBe(false);
    expect(probe.current!.note).toBeNull();

    await pass(1_300);
    expect(findCard("b")!.hasAttribute("data-failed")).toBe(true);
    expect(probe.current!.note).toBe("Review PR failed");
  });

  it("rises as soon as the pointer leaves the card", async () => {
    const { rerender } = render(<Harness board={before} />);
    const pointer = hover(findCard("b")!);

    rerender(<Harness board={failed} />);
    await pass(1_000);
    expect(findCard("b")!.hasAttribute("data-failed")).toBe(false);

    pointer.isOver = false;
    await pass(240);

    expect(findCard("b")!.hasAttribute("data-failed")).toBe(true);
  });

  it("shows at once when the hand is far away", async () => {
    const { rerender } = render(<Harness board={before} />);

    rerender(<Harness board={failed} />);
    await pass(0);

    expect(findCard("b")!.hasAttribute("data-failed")).toBe(true);
  });
});

describe("a Task that arrives", () => {
  const crowded = buildBoard(...cardsOf("a", "b", "c", "d", "e"));

  it("moves nothing when it lies past the rows the cell shows, and the line says it arrived", async () => {
    const frames = vi.spyOn(window, "requestAnimationFrame");
    const { rerender } = render(<Harness board={buildBoard(...cardsOf("a", "b", "c", "d"))} />);

    rerender(<Harness board={crowded} />);
    await pass(0);

    expect(probe.current!.note).toBe("New: Task e");
    expect(findCard("e")).toBeNull();
    expect(frames).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".work-desk [style], .work-desk .is-moving")).toHaveLength(0);
  });

  it("rises at the end of its cell once the hand is still, and not before", async () => {
    const frames = vi.spyOn(window, "requestAnimationFrame");
    const { rerender } = render(<Harness board={buildBoard(...cardsOf("a", "b"))} />);
    const pointer = hover(findCard("a")!);
    // The cell is where the Task lands, so a pointer resting in it holds the Task back.
    const cell = document.querySelector<HTMLElement>("[data-cell-id]")!;
    const cellPointer = hover(cell);

    rerender(<Harness board={buildBoard(...cardsOf("a", "b", "c"))} />);
    await pass(2_000);
    expect(findCard("c")).toBeNull();

    pointer.isOver = false;
    cellPointer.isOver = false;
    await pass(240);

    expect(findCard("c")).not.toBeNull();
    expect(frames).toHaveBeenCalled();
    expect(findCard("c")!.style.opacity).not.toBe("");
  });

  it("fades in at once when the user added it, without waiting for the hand", async () => {
    const { rerender } = render(<Harness board={buildBoard(...cardsOf("a"))} />);
    hover(document.querySelector<HTMLElement>("[data-cell-id]")!);

    act(() => {
      probe.current!.noteAddedTask("c");
    });
    rerender(<Harness board={buildBoard(...cardsOf("a", "c"))} />);
    await pass(0);

    expect(findCard("c")).not.toBeNull();
    expect(probe.current!.note).toBeNull();
  });
});

describe("a read while a card is in the hand", () => {
  it("is drawn after the drop, as one change", async () => {
    const { rerender } = render(<Harness board={buildBoard(...cardsOf("a", "b"))} />);
    const desk = document.querySelector<HTMLElement>(".work-desk")!;
    await act(async () => {
      desk.setAttribute("data-carrying", "");
      await Promise.resolve();
    });

    rerender(<Harness board={buildBoard(...cardsOf("a", "b", "c"))} />);
    await pass(9_000);
    expect(findCard("c")).toBeNull();

    await act(async () => {
      desk.removeAttribute("data-carrying");
      await Promise.resolve();
    });
    await pass(0);

    expect(findCard("c")).not.toBeNull();
  });
});
