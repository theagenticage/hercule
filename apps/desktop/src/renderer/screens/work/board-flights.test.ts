/** Tests the hand-off of a colleague's head and paws, and the same played backwards for Undo. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBody } from "../../app/motion";
import { playHandOff, playHandOffBack } from "./board-flights";

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
