/** Tests the hand-off of a colleague's head and paws, played backwards for Undo, and the copies of cards in flight. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBody } from "../../app/motion";
import {
  findFoldTarget,
  growCardsFromOrigins,
  launchFlights,
  playHandOff,
  playHandOffBack,
  recordGrowthOrigins,
} from "./board-flights";

/** One frame of a 60 Hz display, in milliseconds. */
const FRAME = 16;

/** Long enough for the slowest spring to come to rest. */
const SETTLE_TIME = 4000;

/** Returns a card with a colleague's head and paws, or with none, in the page. */
const makeCard = (hasColleague = true) => {
  const card = document.createElement("div");
  const head = document.createElement("span");
  head.className = "card-head";
  const paws = document.createElement("span");
  paws.className = "card-paws";
  if (hasColleague) card.append(head, paws);
  document.body.append(card);
  return { card, head, paws };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  document.documentElement.style.setProperty("--dur-2", "200ms");
});

afterEach(() => {
  vi.advanceTimersByTime(SETTLE_TIME);
  vi.useRealTimers();
  document.documentElement.style.removeProperty("--dur-2");
  document.body.replaceChildren();
});

describe("playHandOffBack", () => {
  it("takes the paws off the edge first, then sinks the head, as the hand-off played backwards", () => {
    const { card, head, paws } = makeCard();

    playHandOffBack(card);
    vi.advanceTimersByTime(FRAME * 3);
    // Within the first 90ms only the paws move.
    expect(findBody(paws)!.values.o).toBeLessThan(1);
    expect(findBody(head)!.values.y).toBe(0);

    vi.advanceTimersByTime(FRAME * 8);
    expect(findBody(head)!.values.y).toBeGreaterThan(0);
  });

  it("hands both parts back to the stylesheet when they are done, so the card shows the colleague it has", () => {
    const { card, head, paws } = makeCard();

    playHandOffBack(card);
    vi.advanceTimersByTime(SETTLE_TIME);

    for (const part of [head, paws]) {
      expect(part.style.transform).toBe("");
      expect(part.style.opacity).toBe("");
    }
  });

  it("moves the head the opposite way to the hand-off", () => {
    const rising = makeCard();
    const sinking = makeCard();
    playHandOff(rising.card);
    playHandOffBack(sinking.card);
    const heights = (): [number, number] => [
      findBody(rising.head)!.values.y,
      findBody(sinking.head)!.values.y,
    ];
    const [risingBefore, sinkingBefore] = heights();

    vi.advanceTimersByTime(FRAME * 12);
    const [risingAfter, sinkingAfter] = heights();

    expect(risingAfter).toBeLessThan(risingBefore);
    expect(sinkingAfter).toBeGreaterThan(sinkingBefore);
  });

  it("does nothing for a card with no colleague, and under Reduce motion", () => {
    const empty = makeCard(false);
    expect(() => {
      playHandOffBack(empty.card);
    }).not.toThrow();

    document.documentElement.style.setProperty("--dur-2", "0s");
    const reduced = makeCard();
    playHandOffBack(reduced.card);
    expect(findBody(reduced.head)).toBeUndefined();
    expect(findBody(reduced.paws)).toBeUndefined();
  });
});

describe("copies of cards in flight", () => {
  /** Returns a desk with a scroller holding one lane with one card on screen. */
  const makeBoard = () => {
    const desk = document.createElement("div");
    desk.className = "work-desk";
    const scroller = document.createElement("div");
    const lane = document.createElement("section");
    lane.dataset["laneId"] = "lane-1";
    const card = document.createElement("div");
    card.dataset["cardId"] = "t1";
    card.dataset["stage"] = "building";
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 600);
    card.getBoundingClientRect = () => new DOMRect(100, 100, 200, 90);
    lane.append(card);
    scroller.append(lane);
    desk.append(scroller);
    document.body.append(desk);
    return { desk, scroller, lane, card };
  };

  it("is not found as a card by the id the real cards are found by", () => {
    const { desk, scroller, card } = makeBoard();

    launchFlights(scroller, [card], 0);

    expect(desk.querySelectorAll("[data-card-id]")).toHaveLength(1);
    expect(desk.querySelector(".board-flights [data-flight-card]")).not.toBeNull();
  });

  it("is reused when the lane opens again while it flies: the card grows from the copy, which goes", () => {
    const { desk, scroller, lane, card } = makeBoard();
    launchFlights(scroller, [card], 0);

    const origins = recordGrowthOrigins(scroller, [lane]);

    expect(origins.size).toBe(1);
    expect([...origins.values()][0]).toMatchObject({ isLive: true, opacity: 1 });
    expect(desk.querySelector("[data-flight-card]")).toBeNull();
    growCardsFromOrigins([lane], origins, new Map());
    expect(findBody(card)).toBeDefined();
  });
});

describe("the target of a card that folds", () => {
  /** Returns a folded line with a bead for `t1` in Building and a count for each of two stages. */
  const makeLine = () => {
    const line = document.createElement("div");
    line.dataset["foldRow"] = "row-1";
    const building = document.createElement("span");
    building.dataset["stage"] = "building";
    const bead = document.createElement("button");
    bead.dataset["beadTaskId"] = "t1";
    building.append(bead);
    const planned = document.createElement("span");
    planned.dataset["stage"] = "planned";
    line.append(planned, building);
    return { line, bead, building, planned };
  };

  it("is the bead of the card's Task when the line has one", () => {
    const { line, bead } = makeLine();

    expect(findFoldTarget(line, "t1", "planned")).toBe(bead);
  });

  it("is the count of the card's stage when the line has no bead for it", () => {
    const { line, planned } = makeLine();

    expect(findFoldTarget(line, "t2", "planned")).toBe(planned);
  });

  it("is nothing when the line is not folded or has neither", () => {
    const { line } = makeLine();

    expect(findFoldTarget(null, "t1", "building")).toBeNull();
    expect(findFoldTarget(line, "t2", "landed")).toBeNull();
  });
});

describe("cards that grow out of beads", () => {
  it("starts a card at its bead, not at the count of its stage", () => {
    const desk = document.createElement("div");
    desk.className = "work-desk";
    const scroller = document.createElement("div");
    const row = document.createElement("section");
    row.dataset["laneId"] = "row-1";
    const line = document.createElement("div");
    line.dataset["foldRow"] = "row-1";
    const count = document.createElement("span");
    count.dataset["stage"] = "building";
    count.getBoundingClientRect = () => new DOMRect(700, 40, 20, 14);
    const bead = document.createElement("button");
    bead.dataset["beadTaskId"] = "t1";
    bead.getBoundingClientRect = () => new DOMRect(496, 46, 8, 8);
    count.append(bead);
    line.append(count);
    row.append(line);
    scroller.append(row);
    desk.append(scroller);
    document.body.append(desk);

    const origins = recordGrowthOrigins(scroller, [row]);
    line.remove();
    // The row is open now: the card stands in its band.
    const card = document.createElement("div");
    card.dataset["cardId"] = "t1";
    card.dataset["stage"] = "building";
    card.getBoundingClientRect = () => new DOMRect(100, 100, 200, 90);
    row.append(card);
    growCardsFromOrigins([row], origins, new Map());

    // The card's center is (200, 145) and the bead's is (500, 50).
    expect(findBody(card)!.values).toMatchObject({ x: 300, y: -95, s: 0.1, o: 0 });
  });
});
