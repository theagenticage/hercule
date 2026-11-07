/**
 * Tests that `useBoardReads` draws nothing nobody caused while a card is in
 * the hand. The wait for a still hand is replaced by one the test ends when
 * it chooses, so a held change can be released during a carry: that the wait
 * itself refuses to end during a drag is tested in `app/motion/still-hand.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useRef, type JSX } from "react";
import { buildBoard, buildCard, FAILURE } from "@hercule/client-core/work/testing";
import type { WorkBoard } from "@hercule/contract";
import { useBoardReads } from "./use-board-reads";

/** Ends the waits that have started, in the order they started. */
const endWaits: (() => void)[] = [];

vi.mock("../../app/motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/motion")>()),
  waitForStillHand: vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        endWaits.push(() => {
          resolve(true);
        });
      }),
  ),
}));

/** Draws a card element per card the hook returns, so a test can see what is drawn. */
function Harness({ board }: { readonly board: WorkBoard }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const reads = useBoardReads({ board, serverBoard: board, scrollRef });
  return (
    <div className="work-desk">
      <div ref={scrollRef} className="board-scroll">
        <div className="board-cell" data-cell-id="no-project/exploring">
          {reads.board?.cards.map((card) => (
            <div
              key={card.id}
              className="desk-card"
              data-card-id={card.id}
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

afterEach(() => {
  endWaits.length = 0;
});

describe("a held change released while a card is in the hand", () => {
  it("is drawn after the drop, not under the carried card", async () => {
    const before = buildBoard(buildCard("a"), buildCard("b"));
    const failed = buildBoard(buildCard("a"), buildCard("b", { failure: FAILURE }));
    const { rerender } = render(<Harness board={before} />);
    rerender(<Harness board={failed} />);
    expect(endWaits).toHaveLength(1);
    const desk = document.querySelector<HTMLElement>(".work-desk")!;
    await act(async () => {
      desk.setAttribute("data-carrying", "");
      await Promise.resolve();
    });

    await act(async () => {
      endWaits[0]!();
      await Promise.resolve();
    });
    expect(findCard("b")!.hasAttribute("data-failed")).toBe(false);

    await act(async () => {
      desk.removeAttribute("data-carrying");
      await Promise.resolve();
    });
    expect(findCard("b")!.hasAttribute("data-failed")).toBe(true);
  });
});
