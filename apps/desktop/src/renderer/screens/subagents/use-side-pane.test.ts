/**
 * Tests `useSidePaneLayout` and `useSidePaneWidth`: the layout is kept per
 * thread and shared by every reader, and the width is kept in
 * `localStorage`.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CLOSED_SIDE_PANE, DEFAULT_SIDE_PANE_WIDTH, togglePane } from "@hercule/client-core";
import { forgetSidePaneLayouts, useSidePaneLayout, useSidePaneWidth } from "./use-side-pane";

afterEach(() => {
  forgetSidePaneLayouts();
  localStorage.clear();
});

describe("useSidePaneLayout", () => {
  it("starts closed", () => {
    expect(renderHook(() => useSidePaneLayout("ses_1")).result.current.layout).toBe(
      CLOSED_SIDE_PANE,
    );
  });

  it("shows a change to every reader of the same thread, and to no other thread", () => {
    const first = renderHook(() => useSidePaneLayout("ses_1"));
    const second = renderHook(() => useSidePaneLayout("ses_1"));
    const other = renderHook(() => useSidePaneLayout("ses_2"));
    act(() => {
      first.result.current.changeLayout(togglePane);
    });
    expect(second.result.current.layout.open).toBe(true);
    expect(other.result.current.layout.open).toBe(false);
  });
});

describe("useSidePaneWidth", () => {
  it("reads the default width until one is stored, then the stored one", () => {
    const { result } = renderHook(() => useSidePaneWidth());
    expect(result.current[0]).toBe(DEFAULT_SIDE_PANE_WIDTH);
    act(() => {
      result.current[1](480);
    });
    expect(result.current[0]).toBe(480);
    expect(localStorage.getItem("hercule.side-pane.width")).toBe("480");
  });
});
