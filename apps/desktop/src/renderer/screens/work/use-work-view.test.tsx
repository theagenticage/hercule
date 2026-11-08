/** Tests how the view of the Work board keeps its folds: the block of rows On top, the opened rows, and Fold everything. */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { buildLane } from "@hercule/client-core/work";
import { toggleLaneOrRow, useWorkView } from "./use-work-view";
import { readSavedWorkView, writeSavedWorkView, EMPTY_WORK_VIEW } from "./work-view-storage";

const KEY = "work-view:test";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const renderView = (listed: readonly string[] | undefined) =>
  renderHook(({ ids }) => useWorkView(KEY, ids), { initialProps: { ids: listed } });

describe("the block of rows On top", () => {
  it("is open while a Find text is on, whatever the user saved, and folds again after", () => {
    writeSavedWorkView(KEY, { ...EMPTY_WORK_VIEW, isInitiativeBlockFolded: true });
    const { result } = renderView(["a", "b"]);
    expect(result.current.isInitiativeBlockFolded).toBe(true);

    act(() => {
      result.current.setFindText("refund");
    });
    expect(result.current.isInitiativeBlockFolded).toBe(false);

    act(() => {
      result.current.setFindText("");
    });
    expect(result.current.isInitiativeBlockFolded).toBe(true);
    expect(readSavedWorkView(KEY).isInitiativeBlockFolded).toBe(true);
  });

  it("holds a fold made while filtering only as long as the filter, and saves nothing for it", () => {
    const { result } = renderView(["a", "b"]);
    act(() => {
      result.current.setFilter({ state: ["failed"] });
    });

    act(() => {
      result.current.toggleInitiativeBlock();
    });
    expect(result.current.isInitiativeBlockFolded).toBe(true);
    expect(readSavedWorkView(KEY).isInitiativeBlockFolded).toBe(false);

    act(() => {
      result.current.setFilter({});
    });
    expect(result.current.isInitiativeBlockFolded).toBe(false);
  });
});

describe("the opened rows", () => {
  it("leaves out an Initiative that is no longer listed", () => {
    writeSavedWorkView(KEY, { ...EMPTY_WORK_VIEW, openedInitiativeIds: ["a", "gone"] });
    const { result } = renderView(["a"]);

    expect([...result.current.openedInitiativeIds]).toEqual(["a"]);
  });

  it("keeps every opened row until the list is read", () => {
    writeSavedWorkView(KEY, { ...EMPTY_WORK_VIEW, openedInitiativeIds: ["a", "gone"] });
    const { result } = renderView(undefined);

    expect([...result.current.openedInitiativeIds]).toEqual(["a", "gone"]);
  });

  it("drops an unlisted Initiative from what it saves", () => {
    writeSavedWorkView(KEY, { ...EMPTY_WORK_VIEW, openedInitiativeIds: ["a", "gone"] });
    const { result } = renderView(["a", "b"]);

    act(() => {
      result.current.toggleInitiativeRow("b");
    });

    expect(readSavedWorkView(KEY).openedInitiativeIds).toEqual(["a", "b"]);
  });

  it("folds everything in one press when the only opened row left is a stale one", () => {
    writeSavedWorkView(KEY, {
      ...EMPTY_WORK_VIEW,
      foldedLaneIds: ["storefront"],
      openedInitiativeIds: ["gone"],
    });
    const { result } = renderView(["a"]);

    // Every lane is folded and no listed row is open, so this opens the lanes.
    act(() => {
      result.current.foldEverything(["storefront"]);
    });

    expect(readSavedWorkView(KEY).foldedLaneIds).toEqual([]);
  });
});

describe("toggleLaneOrRow", () => {
  const calls: string[] = [];
  const view = {
    toggleLane: (laneId: string) => calls.push(`lane:${laneId}`),
    toggleInitiativeRow: (initiativeId: string) => calls.push(`row:${initiativeId}`),
  };

  it("folds a row by its Initiative and any other lane by its id", () => {
    toggleLaneOrRow(view, buildLane("storefront", "Storefront", "storefront", []));
    toggleLaneOrRow(
      view,
      buildLane("initiative-row:a", "A", null, [], {
        initiative: { initiativeId: "a", hue: 245, isRow: true, doneRingCount: 0 },
      }),
    );
    toggleLaneOrRow(
      view,
      buildLane("initiative:a", "A", null, [], {
        initiative: { initiativeId: "a", hue: 245, isRow: false },
      }),
    );

    expect(calls).toEqual(["lane:storefront", "row:a", "lane:initiative:a"]);
  });
});
