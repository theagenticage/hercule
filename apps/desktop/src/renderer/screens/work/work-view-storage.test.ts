import { describe, expect, it } from "vitest";
import {
  buildWorkViewKey,
  DEFAULT_WORK_DISPLAY,
  EMPTY_WORK_VIEW,
  readSavedWorkView,
  writeSavedWorkView,
} from "./work-view-storage";

const KEY = buildWorkViewKey("http://controller.test", "noa");

describe("the saved Work view", () => {
  it("reads as empty when nothing is stored", () => {
    expect(readSavedWorkView(KEY)).toEqual(EMPTY_WORK_VIEW);
  });

  it("returns what was written", () => {
    const view = {
      groupBy: "github/repository",
      foldedLaneIds: ["lane-1"],
      openedInitiativeIds: ["checkout-rework"],
      isInitiativeBlockFolded: true,
      display: {
        laneLabels: "bands",
        initiativePlace: "lanes",
        isStill: true,
        hasSingleKeys: false,
      },
    } as const;
    writeSavedWorkView(KEY, view);

    expect(readSavedWorkView(KEY)).toEqual(view);
  });

  it("starts with lane names in bands, and keeps side labels once chosen", () => {
    expect(EMPTY_WORK_VIEW.display.laneLabels).toBe("bands");

    const view = {
      ...EMPTY_WORK_VIEW,
      display: { ...DEFAULT_WORK_DISPLAY, laneLabels: "side-labels" },
    } as const;
    writeSavedWorkView(KEY, view);

    expect(readSavedWorkView(KEY)).toEqual(view);
  });

  it("keeps each user's view apart", () => {
    writeSavedWorkView(KEY, {
      ...EMPTY_WORK_VIEW,
      groupBy: "github/repository",
      foldedLaneIds: ["lane-1"],
      openedInitiativeIds: ["checkout-rework"],
    });

    const other = readSavedWorkView(buildWorkViewKey("http://controller.test", "river"));
    expect(other.foldedLaneIds).toEqual([]);
    expect(other.openedInitiativeIds).toEqual([]);
    expect(other.groupBy).toBe("project");
  });

  it("reads text that is not JSON as empty", () => {
    localStorage.setItem(KEY, "{nope");

    expect(readSavedWorkView(KEY)).toEqual(EMPTY_WORK_VIEW);
  });

  it("keeps the good fields when another field is malformed", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        foldedLaneIds: ["lane-1", 7],
        display: { laneLabels: "grid", isStill: true },
      }),
    );

    expect(readSavedWorkView(KEY)).toEqual({
      ...EMPTY_WORK_VIEW,
      foldedLaneIds: ["lane-1"],
      display: { ...DEFAULT_WORK_DISPLAY, isStill: true },
    });
  });

  it("reads a view saved before Initiatives as rows folded, the block open and rows On top", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        groupBy: "project",
        foldedLaneIds: [],
        display: { laneLabels: "bands", isStill: false, hasSingleKeys: true },
      }),
    );

    const view = readSavedWorkView(KEY);
    expect(view.openedInitiativeIds).toEqual([]);
    expect(view.isInitiativeBlockFolded).toBe(false);
    expect(view.display.initiativePlace).toBe("top");
  });

  it("keeps the good Initiative fields when others are malformed", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        openedInitiativeIds: ["checkout-rework", 3],
        isInitiativeBlockFolded: "yes",
        display: { initiativePlace: "beside" },
      }),
    );

    const view = readSavedWorkView(KEY);
    expect(view.openedInitiativeIds).toEqual(["checkout-rework"]);
    expect(view.isInitiativeBlockFolded).toBe(false);
    expect(view.display.initiativePlace).toBe("top");
  });
});
