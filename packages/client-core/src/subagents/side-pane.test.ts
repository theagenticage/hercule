/**
 * Tests the side pane's layout changes and width rules: `openSurface`,
 * `closeSurface`, `togglePane`, `toggleSurface`, `parseSidePaneLayout`,
 * `parseSidePaneWidth` and `fitSidePaneWidth`.
 */
import { describe, expect, it } from "vitest";
import {
  CLOSED_SIDE_PANE,
  DEFAULT_SIDE_PANE_WIDTH,
  closeSurface,
  fitSidePaneWidth,
  openSurface,
  parseSidePaneLayout,
  parseSidePaneWidth,
  togglePane,
  toggleSurface,
  type SidePaneLayout,
} from "./side-pane";

const OPEN_ON_SUBAGENTS: SidePaneLayout = {
  open: true,
  surfaces: ["subagents"],
  shown: "subagents",
};

describe("side pane layout changes", () => {
  it("opens a surface, adding its tab once", () => {
    expect(openSurface(CLOSED_SIDE_PANE, "subagents")).toEqual(OPEN_ON_SUBAGENTS);
    expect(openSurface(OPEN_ON_SUBAGENTS, "subagents")).toEqual(OPEN_ON_SUBAGENTS);
  });

  it("closes the pane when the last tab closes", () => {
    expect(closeSurface(OPEN_ON_SUBAGENTS, "subagents")).toEqual(CLOSED_SIDE_PANE);
  });

  it("opens a pane with no tabs on Subagents, and keeps the tabs when it closes", () => {
    expect(togglePane(CLOSED_SIDE_PANE)).toEqual(OPEN_ON_SUBAGENTS);
    expect(togglePane(OPEN_ON_SUBAGENTS)).toEqual({ ...OPEN_ON_SUBAGENTS, open: false });
    expect(togglePane({ ...OPEN_ON_SUBAGENTS, open: false })).toEqual(OPEN_ON_SUBAGENTS);
  });

  it("hides the pane when the surface is already shown, and shows it otherwise", () => {
    expect(toggleSurface(OPEN_ON_SUBAGENTS, "subagents")).toEqual({
      ...OPEN_ON_SUBAGENTS,
      open: false,
    });
    expect(toggleSurface(CLOSED_SIDE_PANE, "subagents")).toEqual(OPEN_ON_SUBAGENTS);
  });
});

describe("parseSidePaneLayout", () => {
  it("reads back a stored layout", () => {
    expect(parseSidePaneLayout(JSON.stringify(OPEN_ON_SUBAGENTS))).toEqual(OPEN_ON_SUBAGENTS);
  });

  it.each([null, "not json", "[]", '{"open":true}', '{"open":true,"surfaces":["browser"]}'])(
    "reads %s as a closed pane",
    (raw) => {
      expect(parseSidePaneLayout(raw)).toEqual(CLOSED_SIDE_PANE);
    },
  );

  it("shows the last known tab when the shown surface is unknown", () => {
    expect(
      parseSidePaneLayout('{"open":true,"surfaces":["browser","subagents"],"shown":"browser"}'),
    ).toEqual(OPEN_ON_SUBAGENTS);
  });
});

describe("side pane width", () => {
  it("parses a stored width, and falls back to the default for anything else", () => {
    expect(parseSidePaneWidth("512.4")).toBe(512);
    expect(parseSidePaneWidth(null)).toBe(DEFAULT_SIDE_PANE_WIDTH);
    expect(parseSidePaneWidth("wide")).toBe(DEFAULT_SIDE_PANE_WIDTH);
    expect(parseSidePaneWidth("120")).toBe(DEFAULT_SIDE_PANE_WIDTH);
  });

  it("keeps the pane at least 300px and the main pane at least 520px", () => {
    expect(fitSidePaneWidth(420, undefined)).toBe(420);
    expect(fitSidePaneWidth(200, 1200)).toBe(300);
    expect(fitSidePaneWidth(900, 1200)).toBe(680);
    // Too narrow a window for both: the pane keeps its own minimum.
    expect(fitSidePaneWidth(420, 700)).toBe(300);
  });
});
