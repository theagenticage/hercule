import { describe, expect, it } from "vitest";
import { computeScrollToReveal } from "./keep-in-view";

/** A view from 0 to 800 pixels, scrolled to 300, with 100 covered at the top and 70 at the foot. */
const VIEW = { viewStart: 0, viewEnd: 800, startCovered: 100, endCovered: 70, scroll: 300 };

describe("computeScrollToReveal", () => {
  it.each([
    ["a card inside the uncovered part", 200, 300, 300],
    ["a card whose start is just under the covered top", 100, 200, 300],
    ["a card whose end is just above the covered foot", 600, 730, 300],
    ["a card hidden under the headers at the top", 40, 140, 240],
    ["a card cut by the top of the view", -50, 50, 150],
    ["a card hidden under the foot", 700, 800, 370],
    ["a card below the view", 900, 1000, 570],
    ["a card taller than the uncovered part, which shows its start", 150, 900, 350],
  ])("scrolls for %s the least amount", (_name, cardStart, cardEnd, scroll) => {
    expect(computeScrollToReveal({ ...VIEW, cardStart, cardEnd })).toBe(scroll);
  });
});
