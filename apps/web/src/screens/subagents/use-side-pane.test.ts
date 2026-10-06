import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createMemoryStorage } from "@hercule/ui/testing";
import {
  CLOSED_SIDE_PANE,
  DEFAULT_SIDE_PANE_WIDTH,
  parseSidePaneLayout,
  toggleSidePane,
  type SidePaneLayout,
} from "@hercule/client-core";
import { useSidePaneLayout, useSidePaneWidth } from "./use-side-pane";

const OPEN_ON_SUBAGENTS: SidePaneLayout = {
  open: true,
  surfaces: ["subagents"],
  shown: "subagents",
};

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("useSidePaneLayout", () => {
  it("shares one layout between every reader, kept in sessionStorage", () => {
    const first = renderHook(() => useSidePaneLayout());
    const second = renderHook(() => useSidePaneLayout());
    expect(first.result.current.layout).toEqual(CLOSED_SIDE_PANE);

    act(() => {
      first.result.current.changeLayout(toggleSidePane);
    });

    expect(second.result.current.layout).toEqual(OPEN_ON_SUBAGENTS);
    expect(parseSidePaneLayout(sessionStorage.getItem("hercule.side-pane"))).toEqual(
      OPEN_ON_SUBAGENTS,
    );
  });

  it("keeps the layout in memory when the browser denies storage", () => {
    const denied = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    vi.stubGlobal("sessionStorage", denied);
    const { result } = renderHook(() => useSidePaneLayout());

    act(() => {
      result.current.changeLayout(toggleSidePane);
    });

    expect(result.current.layout).toEqual(OPEN_ON_SUBAGENTS);
  });
});

describe("useSidePaneWidth", () => {
  it("keeps the width in localStorage", () => {
    vi.stubGlobal("localStorage", createMemoryStorage({}));
    const { result } = renderHook(() => useSidePaneWidth());
    expect(result.current[0]).toBe(DEFAULT_SIDE_PANE_WIDTH);

    act(() => {
      result.current[1](480);
    });

    expect(result.current[0]).toBe(480);
    expect(localStorage.getItem("hercule.side-pane.width")).toBe("480");
  });

  // Runs last of the width tests: once a write is refused, the stored width
  // stays in memory for the rest of the file.
  it("keeps a refused width in memory, over the older width storage still holds", () => {
    const full = createMemoryStorage({ "hercule.side-pane.width": "480" });
    full.setItem = () => {
      throw new Error("The quota has been exceeded.");
    };
    vi.stubGlobal("localStorage", full);
    const { result } = renderHook(() => useSidePaneWidth());
    expect(result.current[0]).toBe(480);

    act(() => {
      result.current[1](520);
    });

    expect(result.current[0]).toBe(520);
  });
});
