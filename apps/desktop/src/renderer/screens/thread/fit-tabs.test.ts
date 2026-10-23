/**
 * Tests how the header's pill chooses the tabs it hides behind "+n".
 */
import { describe, expect, it } from "vitest";
import { pickHiddenTabs } from "./fit-tabs";

/** A pill with 100 px of fixed content and a "+n" button of 40 px. */
const pick = (tabWidths: number[], pinned: boolean[], room: number): number[] =>
  [...pickHiddenTabs({ tabWidths, pinned, fixedWidth: 100, overflowWidth: 40, room })].sort();

describe("picking the tabs to hide", () => {
  it("hides nothing when everything fits, even if the button would not", () => {
    // 100 + 60 + 60 = 220 fits exactly; with the button's 40 px it would not.
    expect(pick([60, 60], [false, false], 220)).toEqual([]);
  });

  it("hides nothing for a pill without tabs", () => {
    expect(pick([], [], 50)).toEqual([]);
  });

  it("fills the room in start order and hides the rest", () => {
    // Budget: 300 - 100 - 40 = 160, so two of the four 60 px tabs fit.
    expect(pick([60, 60, 60, 60], [false, false, false, false], 300)).toEqual([2, 3]);
  });

  it("keeps a later, narrower tab that fits after a wider one did not", () => {
    // Budget 160: 100 fits, 80 does not (180), 50 does (150), 20 does not (170).
    expect(pick([100, 80, 50, 20], [false, false, false, false], 300)).toEqual([1, 3]);
  });

  it("keeps a pinned tab and fills the rest around it", () => {
    // Budget 160: the pinned third tab takes 100, then only the 60 px tab fits.
    expect(pick([60, 60, 100, 60], [false, false, true, false], 300)).toEqual([1, 3]);
  });

  it("keeps pinned tabs in front of earlier tabs when the room is short", () => {
    expect(pick([60, 60, 60], [false, false, true], 220)).toEqual([0, 1]);
  });

  it("keeps pinned tabs that are wider than the budget and hides every other tab", () => {
    // Budget 160, and the two pinned tabs take 200.
    expect(pick([40, 100, 100, 40], [false, true, true, false], 300)).toEqual([0, 3]);
  });

  it("reserves the button's width once a tab is hidden", () => {
    // The tabs take 140 and the room 130, so the pill overflows. Budget: 230 - 100 - 40 = 90.
    // Without the button's 40 px the second tab would fit too.
    expect(pick([50, 50, 40], [false, false, false], 230)).toEqual([1]);
  });
});
