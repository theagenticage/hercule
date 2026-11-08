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
import { useHeldChanges, type HeldContext } from "./use-held-changes";

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

const release = vi.fn<(change: HeldChange) => void>();
const beforeRelease = vi.fn<(change: HeldChange, context: HeldContext) => Promise<boolean>>();

/** Returns the keys of the changes released so far, in order. */
const releasedKeys = (): string[] => release.mock.calls.map(([change]) => change.key);

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
  useHeldChanges({
    held,
    board,
    projects: [],
    groupBy: "acme/project",
    isCarrying,
    scrollRef,
    startDelays,
    beforeRelease,
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
  beforeRelease.mockResolvedValue(true);
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
  beforeRelease.mockReset();
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
    expect(releasedKeys()).toContain(buildArrivalKey("arriving"));
  });

  it("goes ahead at once when the pointer rests elsewhere", async () => {
    hoveredTestId = "cell:none:acme/project";

    await renderAndWait(props, 0);

    expect(releasedKeys()).toContain(buildArrivalKey("arriving"));
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
    expect(releasedKeys()).toEqual([buildArrivalKey("arriving")]);
  });

  it("releases nothing that has no cause to show while it is hidden", async () => {
    setVisibility("hidden");

    await renderAndWait(props, 10_000);
    expect(release).not.toHaveBeenCalled();

    setVisibility("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(releasedKeys()).toEqual([buildArrivalKey("arriving")]);
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

describe("a change that waits for something before it is released", () => {
  const arrival = buildCard("arriving");
  const held = [{ kind: "arrival", cardId: "arriving", key: buildArrivalKey("arriving") } as const];
  const props = { held, board: buildBoard(arrival), lanes: { here: ["other"] } };

  it("gives beforeRelease the change and its card, and releases once it resolves true", async () => {
    let finish: (isReady: boolean) => void = () => undefined;
    beforeRelease.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );

    await renderAndWait(props, 0);
    expect(beforeRelease).toHaveBeenCalledOnce();
    expect(beforeRelease.mock.calls[0]![0]).toBe(held[0]);
    expect(beforeRelease.mock.calls[0]![1].card).toBe(arrival);
    expect(release).not.toHaveBeenCalled();

    await act(async () => {
      finish(true);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(release).toHaveBeenCalledExactlyOnceWith(held[0]);
  });

  it("never releases a change whose beforeRelease resolves false", async () => {
    beforeRelease.mockResolvedValue(false);

    await renderAndWait(props, 5_000);

    expect(release).not.toHaveBeenCalled();
  });

  it("aborts the signal beforeRelease got when the change is no longer held", async () => {
    beforeRelease.mockImplementation(() => new Promise<boolean>(() => undefined));
    const { rerender } = render(<Harness {...props} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const { signal } = beforeRelease.mock.calls[0]![1];
    expect(signal.aborted).toBe(false);

    rerender(<Harness {...props} held={[]} />);

    expect(signal.aborted).toBe(true);
  });

  it("starts the wait after its delay", async () => {
    const delays = new Map([[buildArrivalKey("arriving"), 1_500]]);

    await renderAndWait({ ...props, startDelays: delays }, 1_499);
    expect(beforeRelease).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(releasedKeys()).toEqual([buildArrivalKey("arriving")]);
  });

  it("waits for the drop of a drag, and releases after it", async () => {
    const { rerender } = render(<Harness {...props} isCarrying />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(release).not.toHaveBeenCalled();

    rerender(<Harness {...props} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(releasedKeys()).toEqual([buildArrivalKey("arriving")]);
  });
});
