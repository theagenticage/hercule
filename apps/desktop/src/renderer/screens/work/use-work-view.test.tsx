/** Tests how the view of the Work board keeps its folds: the block of rows On top, the opened rows, and Fold everything. */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { buildLane, isBlockFolded, isFolded } from "@hercule/client-core/work";
import { useWorkView } from "./use-work-view";
import { readSavedWorkView, writeSavedWorkView, EMPTY_WORK_VIEW } from "./work-view-storage";

const KEY = "work-view:test";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const STOREFRONT = buildLane("storefront", "Storefront", "storefront", []);
const rowOf = (initiativeId: string) =>
  buildLane(`initiative-row:${initiativeId}`, initiativeId, null, [], {
    initiative: { initiativeId, hue: 245, isRow: true, doneRingCount: 0 },
  });

const renderView = (listed: readonly string[] | undefined) =>
  renderHook(({ ids }) => useWorkView(KEY, ids), { initialProps: { ids: listed } });

describe("the block of rows On top", () => {
  it("is open while a Find text is on, whatever the user saved, and folds again after", () => {
    writeSavedWorkView(KEY, { ...EMPTY_WORK_VIEW, isInitiativeBlockFolded: true });
    const { result } = renderView(["a", "b"]);
    expect(isBlockFolded(result.current.folds)).toBe(true);

    act(() => {
      result.current.setFindText("refund");
    });
    expect(isBlockFolded(result.current.folds)).toBe(false);

    act(() => {
      result.current.setFindText("");
    });
    expect(isBlockFolded(result.current.folds)).toBe(true);
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
    expect(isBlockFolded(result.current.folds)).toBe(true);
    expect(readSavedWorkView(KEY).isInitiativeBlockFolded).toBe(false);

    act(() => {
      result.current.setFilter({});
    });
    expect(isBlockFolded(result.current.folds)).toBe(false);
  });
});

describe("the opened rows", () => {
  it("leaves out an Initiative that is no longer listed", () => {
    writeSavedWorkView(KEY, { ...EMPTY_WORK_VIEW, openedInitiativeIds: ["a", "gone"] });
    const { result } = renderView(["a"]);

    expect([...result.current.folds.saved.openedInitiativeIds]).toEqual(["a"]);
  });

  it("keeps every opened row until the list is read", () => {
    writeSavedWorkView(KEY, { ...EMPTY_WORK_VIEW, openedInitiativeIds: ["a", "gone"] });
    const { result } = renderView(undefined);

    expect([...result.current.folds.saved.openedInitiativeIds]).toEqual(["a", "gone"]);
  });

  it("drops an unlisted Initiative from what it saves", () => {
    writeSavedWorkView(KEY, { ...EMPTY_WORK_VIEW, openedInitiativeIds: ["a", "gone"] });
    const { result } = renderView(["a", "b"]);

    act(() => {
      result.current.toggleFold(rowOf("b"));
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
      result.current.foldEverything([STOREFRONT, rowOf("a")]);
    });

    expect(readSavedWorkView(KEY).foldedLaneIds).toEqual([]);
  });
});

describe("toggleFold", () => {
  it("saves the fold of a lane and the opening of a row", () => {
    const { result } = renderView(["a"]);

    act(() => {
      result.current.toggleFold(STOREFRONT);
    });
    act(() => {
      result.current.toggleFold(rowOf("a"));
    });

    expect(isFolded(result.current.folds, STOREFRONT)).toBe(true);
    expect(isFolded(result.current.folds, rowOf("a"))).toBe(false);
    expect(readSavedWorkView(KEY)).toMatchObject({
      foldedLaneIds: ["storefront"],
      openedInitiativeIds: ["a"],
    });
  });

  it("holds a fold made while filtering only as long as the filter, and saves nothing for it", () => {
    const { result } = renderView(["a"]);
    act(() => {
      result.current.setFilter({ state: ["failed"] });
    });

    act(() => {
      result.current.toggleFold(STOREFRONT);
    });
    expect(isFolded(result.current.folds, STOREFRONT)).toBe(true);
    expect(readSavedWorkView(KEY).foldedLaneIds).toEqual([]);

    act(() => {
      result.current.setFilter({});
    });
    expect(isFolded(result.current.folds, STOREFRONT)).toBe(false);
  });
});
