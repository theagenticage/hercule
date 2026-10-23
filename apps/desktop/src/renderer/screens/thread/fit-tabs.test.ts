/**
 * Tests how the header's pill chooses the tabs it hides behind "+n", and the
 * widths it gives the open tab and the crumbs' names. These are pure
 * decisions over measured widths, because jsdom has no layout.
 */
import { describe, expect, it } from "vitest";
import { fitPill, pickHiddenTabs } from "./fit-tabs";

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
  crumbs?: number;
}): number[] =>
  [
    ...pickHiddenTabs({
      tabWidths: layout.tabs,
      openIndex: layout.open ?? null,
      waiting: layout.tabs.map((_, index) => (layout.waiting ?? []).includes(index)),
      fixedWidth: 100,
      nameWidth: layout.name ?? 0,
      crumbTextWidth: layout.crumbs ?? 0,
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

describe("when the pinned tabs do not fit beside the crumbs' names", () => {
  it("hides the unpinned tabs before the crumbs' names shrink", () => {
    // Budget: 340 - 100 - 80 - 40 = 120. The open tab takes 60, so one more tab fits.
    expect(pick({ tabs: [60, 60, 60], open: 0, crumbs: 80, room: 340 })).toEqual([2]);
  });

  it("keeps a waiting tab by letting the names shrink, not by hiding the waiting tab", () => {
    // Open and waiting tabs take 120. The names (100 + 150) leave no room for them, but 300 - 100 - 40
    // = 160 is enough once both are gone.
    expect(
      pick({ tabs: [60, 60, 60], open: 0, waiting: [1], name: 100, crumbs: 150, room: 300 }),
    ).toEqual([2]);
  });

  it("hides a waiting tab only when the pinned tabs do not fit even without the names", () => {
    // Pinned: 4 x 60 = 240. With every name gone, 280 - 100 - 40 = 140 is left: the open tab and
    // the first waiting tab fit (120), the others do not.
    expect(
      pick({
        tabs: [60, 60, 60, 60],
        open: 0,
        waiting: [1, 2, 3],
        name: 100,
        crumbs: 150,
        room: 280,
      }),
    ).toEqual([2, 3]);
  });
});

/** Fits a pill with a 40 px button and a gap of 8 px in `room`; the fixed content is 100 px unless `fixed` says otherwise. */
const fit = (layout: {
  tabs: number[];
  room: number;
  open?: number;
  waiting?: number[];
  name?: number;
  crumbs?: number[];
  fixed?: number;
  openMin?: number;
}): ReturnType<typeof fitPill> =>
  fitPill({
    tabWidths: layout.tabs,
    openIndex: layout.open ?? null,
    waiting: layout.tabs.map((_, index) => (layout.waiting ?? []).includes(index)),
    fixedWidth: layout.fixed ?? 100,
    nameWidth: layout.name ?? 0,
    crumbTextWidths: layout.crumbs ?? [],
    overflowWidth: 40,
    room: layout.room,
    gap: 8,
    openTabMinWidth: layout.openMin ?? 0,
  });

describe("fitting the pill", () => {
  it("limits nothing while everything fits", () => {
    const result = fit({ tabs: [60, 60], open: 0, name: 50, crumbs: [30, 40], room: 340 });
    expect(result.hiddenIndexes.size).toBe(0);
    expect(result.openTabMaxWidth).toBeNull();
    expect(result.crumbTextMaxWidths).toEqual([null, null]);
  });

  it("limits the open tab to what the room leaves once the crumbs' names are gone", () => {
    // A 178 px tab and the 8 px gap after it beside 74 px of fixed content, in a room of 180:
    // 106 px are left for the tab and its gap.
    const result = fit({ tabs: [186], open: 0, fixed: 74, room: 180, crumbs: [40] });
    expect(result.openTabMaxWidth).toBe(98);
    expect(result.crumbTextMaxWidths).toEqual([0]);
  });

  it("limits the open tab the same way with no work's name and no hidden tab", () => {
    // The endless-resize case: the limited tab and the fixed content fill the room exactly. The
    // fit reads the tab's natural width, so the limit is the same however often the pill is fitted.
    const input = { tabs: [186], open: 0, fixed: 74, room: 180 };
    const first = fit(input);
    expect(first.openTabMaxWidth).toBe(98);
    expect(fit(input)).toEqual(first);
  });

  it("removes the limit when the room grows back", () => {
    const narrow = fit({ tabs: [186], open: 0, fixed: 74, room: 180 });
    const wide = fit({ tabs: [186], open: 0, fixed: 74, room: 400 });
    expect(narrow.openTabMaxWidth).not.toBeNull();
    expect(wide.openTabMaxWidth).toBeNull();
  });

  it("leaves the open tab whole when it just fits", () => {
    expect(fit({ tabs: [106], open: 0, fixed: 74, room: 180 }).openTabMaxWidth).toBeNull();
  });

  it("never lets the parts that cannot shrink take more than the room", () => {
    const tabs = [90, 90, 90];
    const crumbs = [70, 90];
    for (let room = 150; room <= 600; room += 5) {
      const result = fit({ tabs, open: 1, waiting: [2], name: 120, crumbs, room });
      const visibleTabs = tabs
        .map((width, index) => {
          if (result.hiddenIndexes.has(index)) return 0;
          return index === 1 && result.openTabMaxWidth !== null
            ? result.openTabMaxWidth + 8
            : width;
        })
        .reduce((sum, width) => sum + width, 0);
      const crumbWidth = crumbs.reduce(
        (sum, width, index) => sum + (result.crumbTextMaxWidths[index] ?? width),
        0,
      );
      const button = result.hiddenIndexes.size > 0 ? 40 : 0;
      // Beside the work's name, which shrinks to nothing, this is all that is left to fit.
      expect(100 + button + visibleTabs + crumbWidth).toBeLessThanOrEqual(room);
    }
  });

  it("shortens the crumbs' names, the widest first, before it hides a waiting tab", () => {
    // Open and waiting tabs take 120 of the 160 left beside the button once the work's name is
    // gone. The names (70 + 90) get the other 40, shared evenly because both are wider than 20.
    const result = fit({
      tabs: [60, 60, 60],
      open: 0,
      waiting: [1],
      name: 100,
      crumbs: [70, 90],
      room: 300,
    });
    expect([...result.hiddenIndexes]).toEqual([2]);
    expect(result.crumbTextMaxWidths).toEqual([20, 20]);
    expect(result.openTabMaxWidth).toBeNull();
  });

  it("keeps a short crumb name whole while the widest ones shrink", () => {
    // 100 are left for the names. The short one (20) fits; the others share the other 80.
    const result = fit({ tabs: [], crumbs: [200, 20, 120], room: 200 });
    expect(result.crumbTextMaxWidths).toEqual([40, null, 40]);
  });

  it("limits no crumb name while the work's name alone gives way", () => {
    // 160 are left beside the button, the pinned tabs take 120 and the crumb's name 40: it fits whole.
    const result = fit({
      tabs: [60, 60, 60],
      open: 0,
      waiting: [1],
      name: 100,
      crumbs: [40],
      room: 300,
    });
    expect(result.crumbTextMaxWidths).toEqual([null]);
  });

  it("hides waiting tabs only when even the crumbs' names at zero leave no room", () => {
    // With every name gone, 260 - 100 - 40 = 120 are left: the open tab and one waiting tab.
    const result = fit({
      tabs: [60, 60, 60, 60],
      open: 0,
      waiting: [1, 2, 3],
      name: 100,
      crumbs: [70],
      room: 260,
    });
    expect([...result.hiddenIndexes]).toEqual([2, 3]);
    expect(result.crumbTextMaxWidths).toEqual([0]);
  });

  it("shortens the open tab last, when it alone is wider than the room", () => {
    // The waiting tab hides. Of the 300 px, 100 are fixed and 40 are the button, and the open tab
    // is 400 wide, so it keeps 160 px, less the 8 px gap after it.
    const result = fit({
      tabs: [400, 50],
      open: 0,
      waiting: [1],
      name: 100,
      crumbs: [70],
      room: 300,
    });
    expect([...result.hiddenIndexes]).toEqual([1]);
    expect(result.openTabMaxWidth).toBe(152);
    expect(result.crumbTextMaxWidths).toEqual([0]);
  });

  it("never limits the open tab below the width of its mark and padding", () => {
    // 106 would be left for the tab and its gap, but its mark and padding take 120.
    const result = fit({ tabs: [186], open: 0, fixed: 74, room: 180, openMin: 120 });
    expect(result.openTabMaxWidth).toBe(120);
    // A tab that cannot be shortened at all (its minimum is its whole width) takes no limit.
    const whole = fit({ tabs: [186], open: 0, fixed: 74, room: 180, openMin: 178 });
    expect(whole.openTabMaxWidth).toBeNull();
  });

  it("has no open tab to limit when none is open", () => {
    expect(fit({ tabs: [400], room: 300 }).openTabMaxWidth).toBeNull();
  });
});
