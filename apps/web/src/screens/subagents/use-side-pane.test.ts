import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createMemoryStorage } from "@hercule/ui/testing";
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
  useSidePaneLayout,
  useSidePaneWidth,
  type SidePaneLayout,
} from "./use-side-pane";

const OPEN_ON_SUBAGENTS: SidePaneLayout = {
  open: true,
  surfaces: ["subagents"],
  shown: "subagents",
};

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

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

describe("useSidePaneLayout", () => {
  it("shares one layout between every reader, kept in sessionStorage", () => {
    const first = renderHook(() => useSidePaneLayout());
    const second = renderHook(() => useSidePaneLayout());
    expect(first.result.current.layout).toEqual(CLOSED_SIDE_PANE);

    act(() => {
      first.result.current.changeLayout(togglePane);
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
      result.current.changeLayout(togglePane);
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
