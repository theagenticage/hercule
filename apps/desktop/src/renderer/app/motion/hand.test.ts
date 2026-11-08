import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAND_STILL_AFTER_MS, HandTracker } from "./hand";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a hand", () => {
  it("reads a throw in the direction of the moves, in pixels a second", () => {
    const hand = new HandTracker(0, 0);
    for (let step = 1; step <= 10; step++) {
      vi.advanceTimersByTime(16);
      hand.moveTo(step * 8, 0);
    }
    const { x, y } = hand.readThrow();
    // 8 px every 16 ms is 500 px a second; the smoothing has not quite reached it.
    expect(x).toBeGreaterThan(300);
    expect(x).toBeLessThanOrEqual(500);
    expect(y).toBe(0);
    expect(hand.x).toBe(80);
  });

  it("never reads a throw faster than the cap, in either direction", () => {
    const hand = new HandTracker(0, 0);
    for (let step = 1; step <= 10; step++) {
      vi.advanceTimersByTime(8);
      hand.moveTo(-step * 400, step * 400);
    }
    expect(hand.readThrow()).toEqual({ x: -2500, y: 2500 });
  });

  it("reads no throw once the pointer has been still", () => {
    const hand = new HandTracker(0, 0);
    vi.advanceTimersByTime(16);
    hand.moveTo(40, 0);
    expect(hand.isStill()).toBe(false);
    vi.advanceTimersByTime(HAND_STILL_AFTER_MS + 1);
    expect(hand.isStill()).toBe(true);
    expect(hand.readThrow()).toEqual({ x: 0, y: 0 });
  });
});
