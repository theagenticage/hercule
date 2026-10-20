/** Tests which parts of the opening sheet cascade in, and when each starts. */
import { describe, expect, it } from "vitest";
import { planCascade } from "./tracking-sheet-motion";
import type { RowPlace } from "./use-row-motion";

/** The part of the sheet that shows: 600px tall, from 100px under the window's top. */
const VIEWPORT: RowPlace = { top: 100, bottom: 700 };

/** Returns the places of `count` parts of 40px, one under the other, from `top`. */
const stackParts = (count: number, top = 100): ReadonlyArray<RowPlace> =>
  Array.from({ length: count }, (_, index) => ({
    top: top + index * 40,
    bottom: top + index * 40 + 40,
  }));

describe("planCascade", () => {
  it("starts the first part at 60ms and each next one 16ms later", () => {
    expect(planCascade(stackParts(3), VIEWPORT, 200)).toEqual([
      { index: 0, delay: 60 },
      { index: 1, delay: 76 },
      { index: 2, delay: 92 },
    ]);
  });

  it("leaves out the parts that are out of view, and counts only the parts on screen", () => {
    const places = [...stackParts(2, 0), ...stackParts(2, 300), ...stackParts(1, 900)];
    expect(planCascade(places, VIEWPORT, 200)).toEqual([
      { index: 2, delay: 60 },
      { index: 3, delay: 76 },
    ]);
  });

  it("cascades 13 parts at most", () => {
    expect(planCascade(stackParts(30), VIEWPORT, 200)).toHaveLength(13);
  });

  it("is done by 450ms: the last parts start together rather than end later", () => {
    const plan = planCascade(stackParts(13), VIEWPORT, 200);
    expect(Math.max(...plan.map((part) => part.delay + 200))).toBe(450);
    expect(plan.at(-1)!.delay).toBeLessThanOrEqual(250);
  });
});
