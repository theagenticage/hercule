/**
 * Tests how the header's pill chooses the tabs it hides behind "+n".
 */
import { describe, expect, it } from "vitest";
import { pickHiddenTabs } from "./fit-tabs";

/**
 * Picks for a pill with 100 px of fixed content and a "+n" button of 40 px.
 * `waiting` lists the indexes of the waiting tabs.
 */
const pick = (layout: {
  tabs: number[];
  room: number;
  open?: number;
  waiting?: number[];
  name?: number;
}): number[] =>
  [
    ...pickHiddenTabs({
      tabWidths: layout.tabs,
      openIndex: layout.open ?? null,
      waiting: layout.tabs.map((_, index) => (layout.waiting ?? []).includes(index)),
      fixedWidth: 100,
      nameWidth: layout.name ?? 0,
      overflowWidth: 40,
      room: layout.room,
    }),
  ].sort();

describe("picking the tabs to hide", () => {
  it("hides nothing when everything fits, even if the button would not", () => {
    // 100 + 60 + 60 = 220 fits exactly; with the button's 40 px it would not.
    expect(pick({ tabs: [60, 60], room: 220 })).toEqual([]);
  });

  it("hides nothing for a pill without tabs", () => {
    expect(pick({ tabs: [], room: 50 })).toEqual([]);
  });

  it("fills the room in start order and hides the rest", () => {
    // Budget: 300 - 100 - 40 = 160, so two of the four 60 px tabs fit.
    expect(pick({ tabs: [60, 60, 60, 60], room: 300 })).toEqual([2, 3]);
  });

  it("keeps a later, narrower tab that fits after a wider one did not", () => {
    // Budget 160: 100 fits, 80 does not (180), 50 does (150), 20 does not (170).
    expect(pick({ tabs: [100, 80, 50, 20], room: 300 })).toEqual([1, 3]);
  });

  it("reserves the button's width once a tab is hidden", () => {
    // The tabs take 140 and the room 130 after the fixed part, so the pill overflows.
    // Budget: 230 - 100 - 40 = 90. Without the button's 40 px the second tab would fit too.
    expect(pick({ tabs: [50, 50, 40], room: 230 })).toEqual([1]);
  });

  it("keeps the open tab and fills the rest around it", () => {
    // Budget 160: the open third tab takes 100, then only the first 60 px tab fits.
    expect(pick({ tabs: [60, 60, 100, 60], open: 2, room: 300 })).toEqual([1, 3]);
  });

  it("keeps a waiting tab in front of earlier tabs when the room is short", () => {
    expect(pick({ tabs: [60, 60, 60], waiting: [2], room: 220 })).toEqual([0, 1]);
  });

  it("counts the work's name at its natural width while it fills the room", () => {
    // Budget: 300 - 100 - 100 - 40 = 60, so only the open tab stays.
    expect(pick({ tabs: [60, 60, 60], open: 0, name: 100, room: 300 })).toEqual([1, 2]);
  });
});

describe("when the pinned tabs do not fit beside the work's name", () => {
  it("hides every unpinned tab and lets the name shrink, keeping the waiting tab", () => {
    // Open and waiting tabs take 120 and the budget beside a 100 px name is 60.
    // With the name gone, 300 - 100 - 40 = 160 is enough.
    expect(pick({ tabs: [60, 60, 60], open: 0, waiting: [1], name: 100, room: 300 })).toEqual([2]);
  });

  it("shows no button when only pinned tabs remain and they fit once the name shrinks", () => {
    // 100 + 120 fits in 250 with a zero-wide name; reserving the button's 40 px would not.
    expect(pick({ tabs: [60, 60], open: 0, waiting: [1], name: 100, room: 250 })).toEqual([]);
  });
});

describe("when the pinned tabs do not fit even without the work's name", () => {
  it("hides waiting tabs that do not fit, in start order, and keeps the open tab", () => {
    // Budget with a zero-wide name: 300 - 100 - 40 = 160. The open tab takes 60,
    // the first waiting tab fits (120), the second does not (180) and neither does the third.
    expect(
      pick({ tabs: [60, 60, 60, 60], open: 0, waiting: [1, 2, 3], name: 100, room: 300 }),
    ).toEqual([2, 3]);
  });

  it("keeps a later, narrower waiting tab that fits after a wider one did not", () => {
    // After the open tab (60) the 120 px tab does not fit in 160, but the 40 px one does.
    expect(pick({ tabs: [60, 120, 40], open: 0, waiting: [1, 2], name: 100, room: 300 })).toEqual([
      1,
    ]);
  });

  it("hides the unpinned tabs as well", () => {
    expect(pick({ tabs: [60, 120, 40], open: 0, waiting: [1], name: 100, room: 300 })).toEqual([
      1, 2,
    ]);
  });

  it("never hides the open tab, even when it is wider than the room", () => {
    expect(pick({ tabs: [400, 50], open: 0, waiting: [1], room: 300 })).toEqual([1]);
    expect(pick({ tabs: [50, 400], open: 1, waiting: [0], room: 300 })).toEqual([0]);
  });
});
