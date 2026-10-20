/** Tests which parts of the opening sheet cascade in, and when each starts. */
import { describe, expect, it, vi } from "vitest";
import { planCascade } from "./tracking-sheet-motion";
import type { RowPlace } from "./motion-helpers";

/** The part of the sheet that shows: 600px tall, from 100px under the window's top. */
const VIEWPORT: RowPlace = { top: 100, bottom: 700 };

/** Returns the places of `count` parts of 40px, one under the other, from `top`. */
const stackParts = (count: number, top = 100): ReadonlyArray<RowPlace> =>
  Array.from({ length: count }, (_, index) => ({
    top: top + index * 40,
    bottom: top + index * 40 + 40,
  }));

/** Plans the cascade of `places`, whose parts stand in the order given. */
const plan = (places: ReadonlyArray<RowPlace>, duration: number) =>
  planCascade(places.length, (index) => places[index]!, VIEWPORT, duration);

describe("planCascade", () => {
  it("starts the first part at 60ms and each next one 16ms later", () => {
    expect(plan(stackParts(3), 200)).toEqual([
      { index: 0, delay: 60 },
      { index: 1, delay: 76 },
      { index: 2, delay: 92 },
    ]);
  });

  it("leaves out the parts that are out of view, and counts only the parts on screen", () => {
    const places = [...stackParts(2, 0), ...stackParts(2, 300), ...stackParts(1, 900)];
    expect(plan(places, 200)).toEqual([
      { index: 2, delay: 60 },
      { index: 3, delay: 76 },
    ]);
  });

  it("cascades 13 parts at most", () => {
    expect(plan(stackParts(30), 200)).toHaveLength(13);
  });

  it("is done by 450ms: the last parts start together rather than end later", () => {
    const cascade = plan(stackParts(13), 200);
    expect(Math.max(...cascade.map((part) => part.delay + 200))).toBe(450);
    expect(cascade.at(-1)!.delay).toBeLessThanOrEqual(250);
  });

  it("measures only the parts that can cascade: not the parts after the 13th, nor those below the viewport", () => {
    const places = stackParts(40);
    const readPlace = vi.fn((index: number) => places[index]!);
    planCascade(places.length, readPlace, VIEWPORT, 200);
    expect(readPlace).toHaveBeenCalledTimes(13);

    readPlace.mockClear();
    planCascade(places.length, readPlace, { top: 100, bottom: 220 }, 200);
    // Three parts show, and the fourth is the first below the viewport.
    expect(readPlace).toHaveBeenCalledTimes(4);
  });
});
