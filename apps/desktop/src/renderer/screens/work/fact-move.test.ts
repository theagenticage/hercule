/**
 * Tests the dent that a card moving by itself leaves in its old place: it
 * stands for at least 1.5 seconds, and it closes only while the hand is out of
 * the lane, even after the eight seconds a change usually waits. The wait for
 * the hand runs on a fake clock, and the pointer rests on the lane through
 * `:hover`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSelfMoves } from "./fact-move";

/** Whether the pointer rests on the lane. */
let isPointerInLane = false;

/** Makes a `div` with the given class and attributes. */
const makeDiv = (className: string, attributes: Record<string, string> = {}): HTMLElement => {
  const element = document.createElement(className === "board-lane" ? "section" : "div");
  element.className = className;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
};

/** Draws one lane with a cell that holds two cards, and returns the scroller. */
const drawBoard = (): HTMLElement => {
  const desk = makeDiv("work-desk");
  const scroller = makeDiv("board-scroll");
  const lane = makeDiv("board-lane", { "data-lane-id": "webshop" });
  const cell = makeDiv("board-cell", { "data-lane-id": "webshop", "data-stage": "in-review" });
  cell.append(
    makeDiv("desk-card", { "data-card-id": "moving", "data-stage": "in-review" }),
    makeDiv("desk-card", { "data-card-id": "below", "data-stage": "in-review" }),
  );
  lane.append(cell);
  scroller.append(lane);
  desk.append(scroller);
  document.body.append(desk);
  return scroller;
};

/** Plays the move of the card "moving": the dent opens, the card goes, and the dent starts to wait. */
const playMove = (scroller: HTMLElement, isDragging: () => boolean = () => false) => {
  const controller = new AbortController();
  const moves = prepareSelfMoves(scroller, [
    { cardId: "moving", stage: "landed", cause: undefined },
  ]);
  moves.keepPlaces();
  scroller.querySelector("[data-card-id='moving']")!.remove();
  moves.play({ isDragging, signal: controller.signal });
  return controller;
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
  document.body.replaceChildren();
});

describe("the dent of a card that moved by itself", () => {
  it("takes the place of the card at once, so the card below stays where it was", () => {
    const scroller = drawBoard();

    playMove(scroller);

    const cell = scroller.querySelector(".board-cell")!;
    expect([...cell.children].map((child) => child.getAttribute("data-card-id"))).toEqual([
      null,
      "below",
    ]);
    expect(cell.children[0]!.classList.contains("desk-dent")).toBe(true);
  });

  it("stays for 1.5 seconds, then closes when the hand is out of the lane", async () => {
    const scroller = drawBoard();
    playMove(scroller);

    await vi.advanceTimersByTimeAsync(1_499);
    expect(findDent()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(300);
    expect(findDent()).toBeNull();
  });

  it("stays open under a pointer that rests in the lane, past the eight seconds a change waits", async () => {
    const scroller = drawBoard();
    isPointerInLane = true;
    playMove(scroller);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(findDent()).not.toBeNull();

    isPointerInLane = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(findDent()).toBeNull();
  });

  it("stays open when the pointer comes back to the lane during the 1.5 seconds", async () => {
    const scroller = drawBoard();
    playMove(scroller);

    await vi.advanceTimersByTimeAsync(1_000);
    isPointerInLane = true;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(findDent()).not.toBeNull();

    isPointerInLane = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(findDent()).toBeNull();
  });

  it("closes after a minute at the latest, so a parked pointer does not keep a hole open for good", async () => {
    const scroller = drawBoard();
    isPointerInLane = true;
    playMove(scroller);

    await vi.advanceTimersByTimeAsync(62_000);

    expect(findDent()).toBeNull();
  });

  it("goes at once when the screen goes", async () => {
    const scroller = drawBoard();
    isPointerInLane = true;
    const controller = playMove(scroller);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(findDent()).toBeNull();
  });
});
