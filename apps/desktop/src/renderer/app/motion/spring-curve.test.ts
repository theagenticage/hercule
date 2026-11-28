import { describe, expect, it } from "vitest";
import { buildSpringCurve, buildSpringKnock } from "./spring-curve";
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

describe("buildSpringKnock", () => {
  it("moves off in the direction of the push, by about 2 px for 145 px/s on hand, and ends at rest", () => {
    const { offsets, ms } = buildSpringKnock("hand", 145);
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(0);
    const peak = Math.max(...offsets);
    expect(peak).toBeGreaterThan(1.5);
    expect(peak).toBeLessThan(3);
    expect(offsets.length).toBeGreaterThan(20);
    expect(offsets.length).toBeLessThan(60);
    expect(ms).toBeGreaterThan(200);
    expect(ms).toBeLessThan(600);
  });

  it("scales with the speed, and returns the same knock each time", () => {
    const slow = buildSpringKnock("hand", 50);
    const quick = buildSpringKnock("hand", 100);
    expect(Math.max(...quick.offsets)).toBeCloseTo(2 * Math.max(...slow.offsets), 1);
    expect(buildSpringKnock("hand", 100)).toBe(quick);
  });
});
