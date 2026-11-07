/** Tests the hand-off of a colleague's head and paws, played backwards for Undo, and the copies of cards in flight. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBody } from "../../app/motion";
import {
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
    growCardsFromOrigins([lane], origins);
    expect(findBody(card)).toBeDefined();
  });
});
