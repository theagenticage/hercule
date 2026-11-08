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

const NO_DELAYS: ReadonlyMap<string, number> = new Map();

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
  isCarrying = false,
  startDelays = NO_DELAYS,
}: {
  readonly held: readonly HeldChange[];
  readonly board: WorkBoard;
  readonly lanes: Readonly<Record<string, readonly string[]>>;
  readonly isCarrying?: boolean;
  readonly startDelays?: ReadonlyMap<string, number>;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const note = useHeldChanges({
    held,
    board,
    projects: [],
    groupBy: "acme/project",
    isCarrying,
    scrollRef,
    release,
    startDelays,
  });
  return (
    <div ref={scrollRef}>
      <output>{note}</output>
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
/** Hides or shows the window the way the browser does. */
const setVisibility = (state: DocumentVisibilityState): void => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};

afterEach(() => {
  setVisibility("visible");
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

describe("a window that hides while a change waits", () => {
  const arrival = buildCard("arriving", { contextRefs: [RETURNS.ref] });
  const held = [{ kind: "arrival", cardId: "arriving", key: buildArrivalKey("arriving") } as const];
  const props = {
    held,
    board: buildPlaceBoard(arrival),
    lanes: { [`place:${RETURNS.ref}`]: ["other"] },
  };

  it("releases nothing while it is hidden, and waits for a still hand again when it shows", async () => {
    hoveredTestId = `cell:place:${RETURNS.ref}`;
    await renderAndWait(props, 1_000);

    setVisibility("hidden");
    hoveredTestId = null;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(release).not.toHaveBeenCalled();
    // A hidden window does not poll for the hand either.
    expect(vi.getTimerCount()).toBe(0);

    setVisibility("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(release).toHaveBeenCalledExactlyOnceWith(buildArrivalKey("arriving"));
  });

  it("releases nothing that has no cause to show while it is hidden", async () => {
    setVisibility("hidden");

    await renderAndWait(props, 10_000);
    expect(release).not.toHaveBeenCalled();

    setVisibility("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(release).toHaveBeenCalledExactlyOnceWith(buildArrivalKey("arriving"));
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

describe("a card that a fact moves", () => {
  const MERGED = { factId: 4, ref: "acme:pull-request:6221", text: "Pull request #6221 merged" };
  const merged = buildCard("merging", {
    stage: "landed",
    stageCause: MERGED,
    stageChangedAt: "2026-11-02T12:00:00.000Z",
  });
  const held = [{ kind: "move", cardId: "merging", key: "move:merging:fact-4" } as const];
  const props = { held, board: buildBoard(merged), lanes: { here: ["merging"] } };
  const findLabel = (): HTMLElement | null => document.querySelector<HTMLElement>(".card-cause");

  // A page with no stylesheet counts as reduced motion, which holds the label for 80ms only.
  beforeEach(() => {
    document.documentElement.style.setProperty("--dur-2", "200ms");
  });
  afterEach(() => {
    document.documentElement.style.removeProperty("--dur-2");
  });

  it("shows its cause on the card, holds it for 760ms, and only then lets the card move", async () => {
    await renderAndWait(props, 0);

    expect(findLabel()?.textContent).toBe("Pull request #6221 merged");
    expect(document.querySelector("[data-card-id]")?.hasAttribute("data-cause")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(759);
    });
    expect(release).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(release).toHaveBeenCalledExactlyOnceWith("move:merging:fact-4");
    expect(document.querySelector("output")?.textContent).toBe("Pull request #6221 merged");
  });

  it("waits for the drop when a drag begins during the hold", async () => {
    const { rerender } = render(<Harness {...props} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    rerender(<Harness {...props} isCarrying />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(release).not.toHaveBeenCalled();

    rerender(<Harness {...props} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(release).toHaveBeenCalledExactlyOnceWith("move:merging:fact-4");
  });

  it("holds the move while the window is hidden at the end of the hold, and plays it when it shows", async () => {
    render(<Harness {...props} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(release).not.toHaveBeenCalled();

    setVisibility("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(release).toHaveBeenCalledExactlyOnceWith("move:merging:fact-4");
  });

  it("takes its label away when the change is no longer held", async () => {
    const { rerender } = render(<Harness {...props} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(findLabel()).not.toBeNull();

    rerender(<Harness {...props} held={[]} />);

    expect(findLabel()).toBeNull();
    expect(document.querySelector("[data-card-id]")?.hasAttribute("data-cause")).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(release).not.toHaveBeenCalled();
  });

  it("shows no label for a move that has no cause, and says that the card moved", async () => {
    const plain = buildCard("merging", { stage: "landed", title: "Cache slots" });

    await renderAndWait({ ...props, board: buildBoard(plain) }, 0);

    expect(findLabel()).toBeNull();
    expect(release).toHaveBeenCalledExactlyOnceWith("move:merging:fact-4");
    expect(document.querySelector("output")?.textContent).toBe("Moved: Cache slots");
  });

  it("starts the wait after its delay, and its words stay for 1.5 seconds only", async () => {
    const delays = new Map([["move:merging:fact-4", 1_500]]);

    await renderAndWait({ ...props, startDelays: delays }, 1_499);
    expect(findLabel()).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1 + 760);
    });
    expect(document.querySelector("output")?.textContent).toBe("Pull request #6221 merged");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(document.querySelector("output")?.textContent).toBe("");
  });
});
