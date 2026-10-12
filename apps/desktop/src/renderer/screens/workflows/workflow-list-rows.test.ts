import { describe, expect, it } from "vitest";
import {
  detectWorkflowRowChange,
  mergeWorkflowRowChanges,
  type WorkflowRowMarks,
} from "./workflow-list-rows";

/** A workflow's marks while its run `r-2` runs, after `r-1` completed. */
const RUNNING: WorkflowRowMarks = {
  mark: "working",
  strip: ["done", "working"],
  stripRunIds: ["r-1", "r-2"],
};

describe("detectWorkflowRowChange", () => {
  it("finds no change when the row is built again with the same marks", () => {
    const again = { ...RUNNING, strip: [...RUNNING.strip], stripRunIds: [...RUNNING.stripRunIds] };

    expect(detectWorkflowRowChange(RUNNING, again)).toEqual({
      isMarkChanged: false,
      joinedRunCount: 0,
      changedRunIds: new Set(),
    });
  });

  it("pops the workflow's mark and the run's mark in when the run fails", () => {
    const failed: WorkflowRowMarks = { ...RUNNING, mark: "failed", strip: ["done", "failed"] };

    expect(detectWorkflowRowChange(RUNNING, failed)).toEqual({
      isMarkChanged: true,
      joinedRunCount: 0,
      changedRunIds: new Set(["r-2"]),
    });
  });

  it("steps the strip on when a new run joins it, and pops only the new run in", () => {
    const started: WorkflowRowMarks = {
      mark: "working",
      strip: [...RUNNING.strip, "working"],
      stripRunIds: [...RUNNING.stripRunIds, "r-3"],
    };

    expect(detectWorkflowRowChange(RUNNING, started)).toEqual({
      isMarkChanged: false,
      joinedRunCount: 1,
      changedRunIds: new Set(["r-3"]),
    });
  });

  it("steps the strip on by two slots when two runs join it in one push", () => {
    const twoStarted: WorkflowRowMarks = {
      mark: "working",
      strip: [...RUNNING.strip, "working", "starting"],
      stripRunIds: [...RUNNING.stripRunIds, "r-3", "r-4"],
    };

    expect(detectWorkflowRowChange(RUNNING, twoStarted)).toEqual({
      isMarkChanged: false,
      joinedRunCount: 2,
      changedRunIds: new Set(["r-3", "r-4"]),
    });
  });

  it("does not step the strip on when its newest run was in it before", () => {
    const shorter: WorkflowRowMarks = { mark: "idle", strip: ["done"], stripRunIds: ["r-1"] };

    expect(detectWorkflowRowChange(RUNNING, shorter)).toEqual({
      isMarkChanged: true,
      joinedRunCount: 0,
      changedRunIds: new Set(),
    });
  });

  it("pops only the workflow's mark in when the strip did not change", () => {
    // A start trigger went into error, which moves the workflow to Failing.
    const failing: WorkflowRowMarks = { ...RUNNING, mark: "failed" };

    expect(detectWorkflowRowChange(RUNNING, failing)).toEqual({
      isMarkChanged: true,
      joinedRunCount: 0,
      changedRunIds: new Set(),
    });
  });

  it("steps the strip on and pops the run in when a workflow's first run starts", () => {
    const never: WorkflowRowMarks = { mark: "idle", strip: [], stripRunIds: [] };
    const first: WorkflowRowMarks = { mark: "working", strip: ["starting"], stripRunIds: ["r-1"] };

    expect(detectWorkflowRowChange(never, first)).toEqual({
      isMarkChanged: true,
      joinedRunCount: 1,
      changedRunIds: new Set(["r-1"]),
    });
  });
});

describe("mergeWorkflowRowChanges", () => {
  it("keeps a run's join when the workflow's mark changes in the next push", () => {
    const started: WorkflowRowMarks = {
      mark: "paused",
      strip: [...RUNNING.strip, "working"],
      stripRunIds: [...RUNNING.stripRunIds, "r-3"],
    };
    const marked: WorkflowRowMarks = { ...started, mark: "working" };
    const joined = detectWorkflowRowChange({ ...RUNNING, mark: "paused" }, started);

    expect(mergeWorkflowRowChanges(joined, detectWorkflowRowChange(started, marked))).toEqual({
      isMarkChanged: true,
      joinedRunCount: 1,
      changedRunIds: new Set(["r-3"]),
    });
  });

  it("plays a second join alone, because the strip it joins is drawn afresh", () => {
    const first: WorkflowRowMarks = {
      mark: "working",
      strip: [...RUNNING.strip, "working"],
      stripRunIds: [...RUNNING.stripRunIds, "r-3"],
    };
    const second: WorkflowRowMarks = {
      mark: "working",
      strip: [...first.strip, "working"],
      stripRunIds: [...first.stripRunIds, "r-4"],
    };

    expect(
      mergeWorkflowRowChanges(
        detectWorkflowRowChange(RUNNING, first),
        detectWorkflowRowChange(first, second),
      ),
    ).toEqual({ isMarkChanged: false, joinedRunCount: 1, changedRunIds: new Set(["r-4"]) });
  });

  it("keeps the strip's step when one of its runs changes while it steps", () => {
    const started: WorkflowRowMarks = {
      mark: "working",
      strip: [...RUNNING.strip, "working"],
      stripRunIds: [...RUNNING.stripRunIds, "r-3"],
    };
    const failed: WorkflowRowMarks = { ...started, strip: ["done", "failed", "working"] };

    expect(
      mergeWorkflowRowChanges(
        detectWorkflowRowChange(RUNNING, started),
        detectWorkflowRowChange(started, failed),
      ),
    ).toEqual({ isMarkChanged: false, joinedRunCount: 1, changedRunIds: new Set(["r-3", "r-2"]) });
  });

  it("returns the detected change when nothing is playing", () => {
    const failed: WorkflowRowMarks = { ...RUNNING, mark: "failed", strip: ["done", "failed"] };
    const detected = detectWorkflowRowChange(RUNNING, failed);
    const nothing = detectWorkflowRowChange(RUNNING, RUNNING);

    expect(mergeWorkflowRowChanges(nothing, detected)).toBe(detected);
  });
});
