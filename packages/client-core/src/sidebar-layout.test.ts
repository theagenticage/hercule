import { describe, expect, it } from "vitest";
import {
  decideSidebarDragEnd,
  DEFAULT_SIDEBAR_LAYOUT,
  fitSidebarWidth,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  parseSidebarLayout,
} from "./sidebar-layout";

describe("the sidebar's layout", () => {
  it.each([
    ["nothing stored", null, DEFAULT_SIDEBAR_LAYOUT],
    ["a layout", '{"width":300,"collapsed":true}', { width: 300, collapsed: true }],
    ["a fractional width", '{"width":300.4,"collapsed":false}', { width: 300, collapsed: false }],
    ["text that is not JSON", "wide", DEFAULT_SIDEBAR_LAYOUT],
    ["JSON that is not an object", "300", DEFAULT_SIDEBAR_LAYOUT],
    [
      "a width under the minimum",
      '{"width":100,"collapsed":true}',
      { width: 272, collapsed: true },
    ],
    ["a width over the maximum", '{"width":900}', { width: 272, collapsed: false }],
    [
      "a collapsed that is not a boolean",
      '{"width":300,"collapsed":"yes"}',
      { width: 300, collapsed: false },
    ],
  ])("parses %s", (_, raw, layout) => {
    expect(parseSidebarLayout(raw)).toEqual(layout);
  });

  it.each([
    ["a width within the limits", 300, 1440, 300],
    ["a width under the minimum", 200, 1440, MIN_SIDEBAR_WIDTH],
    ["a width over the maximum", 600, 1440, MAX_SIDEBAR_WIDTH],
    ["a width that leaves the main pane less than its minimum", 400, 860, 340],
    ["a width in the narrowest window the app allows, 800", 400, 800, 280],
    ["a width in a window narrower than both minimums", 400, 700, MIN_SIDEBAR_WIDTH],
  ])("fits %s", (_, width, windowWidth, fitted) => {
    expect(fitSidebarWidth(width, windowWidth)).toBe(fitted);
  });

  it.each([
    ["shows the dragged width, fitted", 500, { width: MAX_SIDEBAR_WIDTH, collapsed: false }],
    [
      "stays at the minimum just above the collapse width",
      160,
      { width: MIN_SIDEBAR_WIDTH, collapsed: false },
    ],
    [
      "collapses below the collapse width, keeping the width before the drag",
      159,
      { width: 300, collapsed: true },
    ],
    ["collapses when dragged past the window's edge", -20, { width: 300, collapsed: true }],
  ])("ends a drag: %s", (_, draggedWidth, layout) => {
    expect(decideSidebarDragEnd(draggedWidth, 300, 1440)).toEqual(layout);
  });
});
