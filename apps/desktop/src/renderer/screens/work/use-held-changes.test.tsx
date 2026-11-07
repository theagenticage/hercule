/**
 * Tests where `useHeldChanges` waits for a still hand: at the lanes that are
 * drawn, whatever the board is grouped by, and at every copy of a card. The
 * wait itself (distances, the drag veto) is tested in
 * `app/motion/still-hand.test.ts`; here the real wait runs on a fake clock, and
 * the pointer rests on an element through `:hover`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useRef, type JSX } from "react";
import { buildBoard, buildCard, buildPlace } from "@hercule/client-core/work/testing";
import { buildArrivalKey, type HeldChange } from "@hercule/client-core/work";
import type { WorkBoard, WorkCard } from "@hercule/contract";
import { useHeldChanges } from "./use-held-changes";

const RETURNS = buildPlace("acme:project:returns", "Returns at the depots");
const PRICING = buildPlace("acme:project:pricing", "Pricing rules");

/** Returns a board of these cards that can be grouped by the places of `acme/project`. */
const buildPlaceBoard = (...cards: readonly WorkCard[]): WorkBoard => ({
  ...buildBoard(...cards),
  places: [RETURNS, PRICING],
  groupings: [{ kind: "acme/project", caption: "Acme project" }],
});

/** The `data-testid` of the element the pointer rests on, or `null` while it rests on none. */
let hoveredTestId: string | null = null;

const release = vi.fn<(key: string) => void>();

/**
 * Draws lanes, each holding the cards of `lanes` in its Exploring cell (the
 * way the board does), and runs the hook over them. The cell of a lane is
 * `cell:<lane id>` and a card is `card:<lane id>:<card id>`.
 */
function Harness({
  held,
  board,
  lanes,
}: {
  readonly held: readonly HeldChange[];
  readonly board: WorkBoard;
  readonly lanes: Readonly<Record<string, readonly string[]>>;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  useHeldChanges({
    held,
    board,
    projects: [],
    groupBy: "acme/project",
    isCarrying: false,
    scrollRef,
    release,
  });
  return (
    <div ref={scrollRef}>
      {Object.entries(lanes).map(([laneId, cardIds]) => (
        <section key={laneId} data-lane-id={laneId}>
          <div data-lane-id={laneId} data-stage="exploring" data-testid={`cell:${laneId}`}>
            {cardIds.map((id) => (
              <div key={id} data-card-id={id} data-testid={`card:${laneId}:${id}`} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  hoveredTestId = null;
  // The mock calls the real method with the element it was called on, so it needs no binding.
  // oxlint-disable-next-line typescript/unbound-method
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector) {
    return selector === ":hover"
      ? hoveredTestId !== null && this.getAttribute("data-testid") === hoveredTestId
      : matches.call(this, selector);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  release.mockReset();
});

/** Renders the harness, then lets the clock run for `ms` milliseconds. */
const renderAndWait = async (props: Parameters<typeof Harness>[0], ms: number): Promise<void> => {
  render(<Harness {...props} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("a Task that arrives while the board is grouped by an outside place", () => {
  const arrival = buildCard("arriving", { contextRefs: [RETURNS.ref] });
  const held = [{ kind: "arrival", cardId: "arriving", key: buildArrivalKey("arriving") } as const];
  const lanes = { [`place:${RETURNS.ref}`]: ["other"], "none:acme/project": [] };
  const props = { held, board: buildPlaceBoard(arrival), lanes };

  it("waits while the pointer rests on the cell of its place's lane, for eight seconds at most", async () => {
    hoveredTestId = `cell:place:${RETURNS.ref}`;

    await renderAndWait(props, 5_000);
    expect(release).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(release).toHaveBeenCalledWith(buildArrivalKey("arriving"));
  });

  it("goes ahead at once when the pointer rests elsewhere", async () => {
    hoveredTestId = "cell:none:acme/project";

    await renderAndWait(props, 0);

    expect(release).toHaveBeenCalledWith(buildArrivalKey("arriving"));
  });
});

describe("a run that fails on a Task drawn in two lanes", () => {
  const failing = buildCard("failing", { contextRefs: [RETURNS.ref, PRICING.ref] });
  const held = [{ kind: "failure", cardId: "failing", key: "failure:run-1" } as const];
  const lanes = {
    [`place:${PRICING.ref}`]: ["failing"],
    [`place:${RETURNS.ref}`]: ["failing"],
  };
  const props = { held, board: buildPlaceBoard(failing), lanes };

  it("waits while the pointer rests on the second copy of the card", async () => {
    hoveredTestId = `card:place:${RETURNS.ref}:failing`;

    await renderAndWait(props, 5_000);

    expect(release).not.toHaveBeenCalled();
  });

  it("waits while the pointer rests on the first copy of the card", async () => {
    hoveredTestId = `card:place:${PRICING.ref}:failing`;

    await renderAndWait(props, 5_000);

    expect(release).not.toHaveBeenCalled();
  });
});
