import { describe, expect, it } from "vitest";
import type { ProbeRect } from "./ui-probe-types";
import { computeLostShare, type ClippingAncestor, type OverflowAxes } from "./ui-probe-clipping";

const WINDOW: ProbeRect = { left: 0, top: 0, right: 1440, bottom: 900 };

const CUTS: OverflowAxes = { cutsX: true, cutsY: true, scrollsX: false, scrollsY: false };
const SCROLLS_DOWN: OverflowAxes = { cutsX: false, cutsY: false, scrollsX: true, scrollsY: true };
// A table that scrolls sideways and cuts what overflows it vertically.
const SCROLLS_SIDEWAYS: OverflowAxes = {
  cutsX: false,
  cutsY: true,
  scrollsX: true,
  scrollsY: false,
};

/** The app's frame: the shell, the body and the root, each as large as the window, cutting. */
const FRAME: ClippingAncestor[] = [
  { facts: CUTS, clip: WINDOW },
  { facts: CUTS, clip: WINDOW },
];

/** A page that scrolls down, beside a 272 px sidebar. */
const PAGE: ClippingAncestor = {
  facts: SCROLLS_DOWN,
  clip: { left: 272, top: 0, right: 1440, bottom: 900 },
};

/** A table that scrolls sideways, starting just below the fold. */
const TABLE_BELOW_FOLD: ClippingAncestor = {
  facts: SCROLLS_SIDEWAYS,
  clip: { left: 304, top: 902, right: 1408, bottom: 1660 },
};

describe("computeLostShare", () => {
  it.each<{ name: string; box: ProbeRect; ancestors: ClippingAncestor[]; lost: number }>([
    {
      name: "loses nothing of a cell in a sideways table below the fold of a page that scrolls",
      box: { left: 320, top: 1000, right: 360, bottom: 1018 },
      ancestors: [TABLE_BELOW_FOLD, PAGE, ...FRAME],
      lost: 0,
    },
    {
      name: "loses nothing of a cell past the right edge of that table, which scrolls sideways to it",
      box: { left: 1420, top: 1000, right: 1460, bottom: 1018 },
      ancestors: [TABLE_BELOW_FOLD, PAGE, ...FRAME],
      lost: 0,
    },
    {
      name: "loses all of a cell in a sideways table that the window cuts off and nothing scrolls to",
      box: { left: 320, top: 1000, right: 360, bottom: 1018 },
      ancestors: [TABLE_BELOW_FOLD, ...FRAME],
      lost: 1,
    },
    {
      name: "loses nothing of text below the window in a page that scrolls down to it",
      box: { left: 320, top: 1500, right: 360, bottom: 1518 },
      ancestors: [{ facts: SCROLLS_DOWN, clip: { left: 0, top: 0, right: 1440, bottom: 2000 } }],
      lost: 0,
    },
    {
      name: "loses the half of a box that an ancestor with overflow hidden cuts",
      box: { left: 100, top: 100, right: 200, bottom: 120 },
      ancestors: [{ facts: CUTS, clip: { left: 0, top: 0, right: 150, bottom: 900 } }],
      lost: 0.5,
    },
  ])("$name", ({ box, ancestors, lost }) => {
    expect(computeLostShare(box, ancestors, WINDOW)).toBeCloseTo(lost);
  });
});
