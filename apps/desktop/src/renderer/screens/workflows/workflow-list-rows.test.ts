import { describe, expect, it } from "vitest";
import { detectRowChange } from "./workflow-list-rows";

/** A workflow's marks while its run `r-2` runs, after `r-1` completed. */
const RUNNING = {
  mark: "working",
  strip: [
    { runId: "r-1", mark: "done" },
    { runId: "r-2", mark: "working" },
  ],
} as const;

describe("detectRowChange", () => {
  it("finds no change when the row is built again with the same marks", () => {
    expect(detectRowChange(RUNNING, { ...RUNNING, strip: [...RUNNING.strip] })).toEqual({
      isMarkChanged: false,
      isStripAdvanced: false,
      changedRunIds: new Set(),
    });
  });

  it("pops the workflow's mark and the run's mark in when the run fails", () => {
    const failed = {
      mark: "failed",
      strip: [RUNNING.strip[0], { runId: "r-2", mark: "failed" }],
    } as const;
    expect(detectRowChange(RUNNING, failed)).toEqual({
      isMarkChanged: true,
      isStripAdvanced: false,
      changedRunIds: new Set(["r-2"]),
    });
  });

  it("steps the strip on when a new run joins it, and pops only the new run in", () => {
    const started = {
      mark: "working",
      strip: [...RUNNING.strip, { runId: "r-3", mark: "working" }],
    } as const;
    expect(detectRowChange(RUNNING, started)).toEqual({
      isMarkChanged: false,
      isStripAdvanced: true,
      changedRunIds: new Set(["r-3"]),
    });
  });
});
