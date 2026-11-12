/**
 * Tests the sequence of a card moving by itself through `useSelfMoves`: the
 * cause lands on the card and holds, a drag makes it wait, the same label goes
 * with the card to its new cell, and the dent it leaves behind stands for at
 * least 1.5 seconds and closes only while the hand is out of the lane, even
 * after the eight seconds a change usually waits. The waits run on a fake
 * clock, and the pointer rests on the lane through `:hover`. A page with no
 * stylesheet counts as Reduce motion, so the tests that need the motion set the
 * `--dur-2` token the way the stylesheet does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect, type JSX } from "react";
import { buildBoard, buildCard } from "@hercule/client-core/work/testing";
import type { HeldChange } from "@hercule/client-core/work";
import type { WorkBoard, WorkCard } from "@hercule/contract";
import { useSelfMoves, type SelfMoves } from "./use-self-moves";

const MERGED = {
  kind: "fact" as const,
  factId: 4,
  ref: "acme:pull-request:6221",
  text: "Pull request #6221 merged",
};

/** The hook's parts, as the last render of the harness gave them. */
let moves: SelfMoves;

/** Whether the pointer rests on the lane. */
let isPointerInLane = false;

function Harness({ isCarrying = false }: { readonly isCarrying?: boolean }): JSX.Element {
  const result = useSelfMoves({ isCarrying });
  useEffect(() => {
    moves = result;
  });
  return <div />;
}

/** Makes an element with the given class and attributes. */
const makeElement = (
  tag: string,
  className: string,
  attributes: Record<string, string> = {},
): HTMLElement => {
  const element = document.createElement(tag);
  element.className = className;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
};

/** Draws one lane with a cell in Review that holds two cards and an empty cell in Building. */
const drawBoard = (): HTMLElement => {
  const desk = makeElement("div", "work-desk");
  const scroller = makeElement("div", "board-scroll");
  const lane = makeElement("section", "board-lane", { "data-lane-id": "webshop" });
  const review = makeElement("div", "board-cell", {
    "data-lane-id": "webshop",
    "data-stage": "in-review",
  });
  review.append(
    makeElement("div", "desk-card", { "data-card-id": "moving", "data-stage": "in-review" }),
    makeElement("div", "desk-card", { "data-card-id": "below", "data-stage": "in-review" }),
  );
  const building = makeElement("div", "board-cell", {
    "data-lane-id": "webshop",
    "data-stage": "building",
  });
  lane.append(review, building);
  scroller.append(lane);
  desk.append(scroller);
  document.body.append(desk);
  return scroller;
};

const findCard = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!;

const MOVE: HeldChange = { kind: "move", cardId: "moving", key: "move:moving:fact-4" };

const BEFORE: WorkBoard = buildBoard(
  buildCard("moving", { stage: "in-review" }),
  buildCard("below", { stage: "in-review" }),
);

/** The board after the card moved to `stage`, last in its new cell. */
const buildAfter = (stage: WorkCard["stage"]): WorkBoard =>
  buildBoard(
    buildCard("below", { stage: "in-review" }),
    buildCard("moving", { stage, stageCause: MERGED }),
  );

/** Draws the read in which the card moved to `stage`: the card leaves its cell, and a new element stands in its new one when the stage is Building. */
const drawMove = (scroller: HTMLElement, stage: WorkCard["stage"]) => {
  moves.noteReleased(MOVE);
  return moves.draw(scroller, { shown: BEFORE, next: buildAfter(stage) }, "self", () => {
    findCard("moving").remove();
    if (stage === "building") {
      scroller
        .querySelector('[data-stage="building"]')!
        .append(
          makeElement("div", "desk-card", { "data-card-id": "moving", "data-stage": "building" }),
        );
    }
  });
};

const findDent = (): Element | null => document.querySelector(".desk-dent");

beforeEach(() => {
  vi.useFakeTimers();
  isPointerInLane = false;
  // The mock calls the real method with the element it was called on, so it needs no binding.
  // oxlint-disable-next-line typescript/unbound-method
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector) {
    return selector === ":hover"
      ? isPointerInLane && this.classList.contains("board-lane")
      : matches.call(this, selector);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty("--dur-2");
  document.body.replaceChildren();
});

describe("announcing a card that moves by itself", () => {
  const announceFor = (card: WorkCard | undefined, signal: AbortSignal) =>
    moves.announce(MOVE, { card, findTargets: () => [findCard("moving")], signal });

  beforeEach(() => {
    document.documentElement.style.setProperty("--dur-2", "200ms");
    drawBoard();
  });

  it("shows the cause on the card, holds it for 760ms, and only then lets the move go ahead", async () => {
    render(<Harness />);
    const result = { value: null as boolean | null };
    void announceFor(buildAfter("landed").cards[1], new AbortController().signal).then(
      (isReady) => {
        result.value = isReady;
      },
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(findCard("moving").querySelector(".card-cause")?.textContent).toBe(
      "Pull request #6221 merged",
    );
    expect(findCard("moving").hasAttribute("data-cause")).toBe(true);
    await vi.advanceTimersByTimeAsync(759);
    expect(result.value).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(result.value).toBe(true);
  });

  it("holds the cause for 80ms only under Reduce motion", async () => {
    document.documentElement.style.setProperty("--dur-2", "0s");
    render(<Harness />);
    const result = { value: null as boolean | null };
    void announceFor(buildAfter("landed").cards[1], new AbortController().signal).then(
      (isReady) => {
        result.value = isReady;
      },
    );

    await vi.advanceTimersByTimeAsync(80);

    expect(result.value).toBe(true);
  });

  it("waits for the drop when a drag begins during the hold", async () => {
    const { rerender } = render(<Harness />);
    const result = { value: null as boolean | null };
    void announceFor(buildAfter("landed").cards[1], new AbortController().signal).then(
      (isReady) => {
        result.value = isReady;
      },
    );
    await vi.advanceTimersByTimeAsync(300);

    rerender(<Harness isCarrying />);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result.value).toBeNull();

    rerender(<Harness />);
    await vi.advanceTimersByTimeAsync(300);
    expect(result.value).toBe(true);
  });

  it("takes the label away when the change is cancelled", async () => {
    render(<Harness />);
    const controller = new AbortController();
    const result = { value: null as boolean | null };
    void announceFor(buildAfter("landed").cards[1], controller.signal).then((isReady) => {
      result.value = isReady;
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelector(".card-cause")).not.toBeNull();

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelector(".card-cause")).toBeNull();
    expect(findCard("moving").hasAttribute("data-cause")).toBe(false);
    expect(result.value).toBe(false);
  });

  it("goes ahead at once, with no label, for a move with no cause and for any other change", async () => {
    render(<Harness />);
    const signal = new AbortController().signal;

    expect(await announceFor(buildCard("moving", { stage: "landed" }), signal)).toBe(true);
    expect(
      await moves.announce(
        { kind: "arrival", cardId: "moving", key: "arrival:moving" },
        { card: buildAfter("landed").cards[1], findTargets: () => [], signal },
      ),
    ).toBe(true);
    expect(document.querySelector(".card-cause")).toBeNull();
  });
});

describe("the card that moved by itself", () => {
  beforeEach(() => {
    document.documentElement.style.setProperty("--dur-2", "200ms");
  });

  it("takes its label to the new element in its new cell, once, and takes it away when it has arrived", async () => {
    const scroller = drawBoard();
    render(<Harness />);
    void moves.announce(MOVE, {
      card: buildAfter("building").cards[1],
      findTargets: () => [findCard("moving")],
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    const label = document.querySelector(".card-cause")!;

    drawMove(scroller, "building");

    const arrived = scroller.querySelector('[data-stage="building"] [data-card-id="moving"]')!;
    expect(arrived.querySelector(".card-cause")).toBe(label);
    expect(document.querySelectorAll(".card-cause")).toHaveLength(1);
    expect(arrived.hasAttribute("data-landing")).toBe(true);

    await vi.advanceTimersByTimeAsync(1_400);
    expect(document.querySelector(".card-cause")).toBeNull();
    expect(arrived.hasAttribute("data-landing")).toBe(false);
  });

  it("is not played as a move by itself when nothing released it", () => {
    const scroller = drawBoard();
    render(<Harness />);

    moves.draw(scroller, { shown: BEFORE, next: buildAfter("building") }, "self", () => {
      findCard("moving").remove();
    });

    expect(findDent()).toBeNull();
  });
});

describe("the dent of a card that moved by itself", () => {
  let closeScreen: () => void;
  beforeEach(() => {
    closeScreen = render(<Harness />).unmount;
  });

  it("takes the place of the card at once, so the card below stays where it was", () => {
    const scroller = drawBoard();

    drawMove(scroller, "landed");

    const cell = scroller.querySelector(".board-cell")!;
    expect([...cell.children].map((child) => child.getAttribute("data-card-id"))).toEqual([
      null,
      "below",
    ]);
    expect(cell.children[0]!.classList.contains("desk-dent")).toBe(true);
  });

  it("stays for 1.5 seconds, then closes when the hand is out of the lane", async () => {
    drawMove(drawBoard(), "landed");

    await vi.advanceTimersByTimeAsync(1_499);
    expect(findDent()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(300);
    expect(findDent()).toBeNull();
  });

  it("stays open under a pointer that rests in the lane, past the eight seconds a change waits", async () => {
    isPointerInLane = true;
    drawMove(drawBoard(), "landed");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(findDent()).not.toBeNull();

    isPointerInLane = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(findDent()).toBeNull();
  });

  it("stays open when the pointer comes back to the lane during the 1.5 seconds", async () => {
    drawMove(drawBoard(), "landed");

    await vi.advanceTimersByTimeAsync(1_000);
    isPointerInLane = true;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(findDent()).not.toBeNull();

    isPointerInLane = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(findDent()).toBeNull();
  });

  it("closes after a minute at the latest, so a parked pointer does not keep a hole open for good", async () => {
    isPointerInLane = true;
    drawMove(drawBoard(), "landed");

    await vi.advanceTimersByTimeAsync(62_000);

    expect(findDent()).toBeNull();
  });

  it("goes at once when the screen goes", async () => {
    isPointerInLane = true;
    drawMove(drawBoard(), "landed");
    expect(findDent()).not.toBeNull();

    act(() => {
      closeScreen();
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(findDent()).toBeNull();
  });
});
