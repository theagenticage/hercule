/** Tests the numbers of sliding a bead: how a stage pulls it like a notch. */
import { describe, expect, it } from "vitest";
import { computeNotchPull, computeSlideOffset } from "./bead-slide";

const STAGE_LEFTS = [100, 250, 400];

describe("computeNotchPull", () => {
  it("pulls the bead 45% of the way to a stage start that is within 26px", () => {
    expect(computeNotchPull(240, STAGE_LEFTS)).toBeCloseTo(4.5);
    expect(computeNotchPull(260, STAGE_LEFTS)).toBeCloseTo(-4.5);
  });

  it("does not pull a bead that is 26px or more from every stage start", () => {
    expect(computeNotchPull(224, STAGE_LEFTS)).toBe(0);
    expect(computeNotchPull(175, STAGE_LEFTS)).toBe(0);
  });

  it("pulls toward the nearest stage start when two are in reach", () => {
    expect(computeNotchPull(110, [100, 130])).toBeCloseTo(-4.5);
  });

  it("pulls nothing when there is no stage", () => {
    expect(computeNotchPull(100, [])).toBe(0);
  });
});

describe("computeSlideOffset", () => {
  it("follows the pointer one to one away from a stage", () => {
    expect(computeSlideOffset(100, 75, STAGE_LEFTS)).toBe(75);
  });

  it("adds the pull of the stage the bead is passing", () => {
    // The bead's left edge reaches 240, 10px before the stage that starts at 250.
    expect(computeSlideOffset(100, 140, STAGE_LEFTS)).toBeCloseTo(144.5);
  });

  it("adds no pull to a bead that stands on a stage start", () => {
    expect(computeSlideOffset(100, 0, STAGE_LEFTS)).toBe(0);
  });
});
