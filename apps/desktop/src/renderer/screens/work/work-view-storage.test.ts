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
      foldedLaneIds: ["lane-1"],
      display: { laneLabels: "bands", isStill: true, hasSingleKeys: false },
    } as const;
    writeSavedWorkView(KEY, view);

    expect(readSavedWorkView(KEY)).toEqual(view);
  });

  it("starts with lane names in bands, and keeps side labels once chosen", () => {
    expect(EMPTY_WORK_VIEW.display.laneLabels).toBe("bands");

    const view = {
      foldedLaneIds: [],
      display: { ...DEFAULT_WORK_DISPLAY, laneLabels: "side-labels" },
    } as const;
    writeSavedWorkView(KEY, view);

    expect(readSavedWorkView(KEY)).toEqual(view);
  });

  it("keeps each user's view apart", () => {
    writeSavedWorkView(KEY, { foldedLaneIds: ["lane-1"], display: DEFAULT_WORK_DISPLAY });

    expect(
      readSavedWorkView(buildWorkViewKey("http://controller.test", "river")).foldedLaneIds,
    ).toEqual([]);
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
      foldedLaneIds: ["lane-1"],
      display: { ...DEFAULT_WORK_DISPLAY, isStill: true },
    });
  });
});
