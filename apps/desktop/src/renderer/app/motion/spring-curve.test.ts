import { describe, expect, it } from "vitest";
import { buildSpringCurve } from "./spring-curve";
import type { SpringName } from "./springs";

/** Returns the numbers of a `linear(...)` easing. */
const readPoints = (ease: string): number[] =>
  ease
    .slice("linear(".length, -1)
    .split(", ")
    .map((point) => Number.parseFloat(point));

describe("buildSpringCurve", () => {
  it.each<[SpringName, number, number]>([
    ["hand", 300, 400],
    ["travel", 430, 540],
    ["self", 950, 1150],
  ])("settles %s in the time its stiffness and damping give (%i to %i ms)", (name, from, to) => {
    const { ms } = buildSpringCurve(name);
    expect(ms).toBeGreaterThanOrEqual(from);
    expect(ms).toBeLessThanOrEqual(to);
  });

  it("starts at 0, ends at 1, and keeps about forty points", () => {
    const points = readPoints(buildSpringCurve("hand").ease);
    expect(points[0]).toBe(0);
    expect(points.at(-1)).toBe(1);
    expect(points.length).toBeGreaterThan(20);
    expect(points.length).toBeLessThan(60);
  });

  it("never overshoots by more than a hundredth, because no spring builds overshoot in", () => {
    for (const name of ["hand", "travel", "self"] as const) {
      const points = readPoints(buildSpringCurve(name).ease);
      expect(Math.min(...points)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...points)).toBeLessThan(1.01);
    }
  });

  it("returns the same curve each time", () => {
    expect(buildSpringCurve("travel")).toBe(buildSpringCurve("travel"));
  });
});
