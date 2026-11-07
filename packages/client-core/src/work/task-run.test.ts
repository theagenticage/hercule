/** Tests the words and the Stop of a run row in the pane. */
import { describe, expect, it } from "vitest";
import type { TrackingDetailRun } from "@hercule/contract";
import { buildTaskRunRow, describeRunStopRefused, describeRunStopRequested } from "./task-run";

const buildRun = (overrides: Partial<TrackingDetailRun> = {}): TrackingDetailRun => ({
  id: "run-1",
  workflowId: "workflow-1",
  workflowName: "Review PR",
  status: "completed",
  createdAt: "2026-11-02T09:00:00.000Z",
  awaitedSignalIds: [],
  ...overrides,
});

describe("a run row of the pane", () => {
  it.each([
    ["pending", {}, "Starting", "dashed", "quiet", true],
    ["running", {}, "Running", "half", "quiet", true],
    [
      "running and waiting for a signal",
      { awaitedSignalIds: ["signal-1"] },
      "Waiting",
      "half",
      "quiet",
      true,
    ],
    ["completed", {}, "Done", "check", "good", false],
    ["failed", {}, "Failed", "cross", "bad", false],
    ["cancelled", {}, "Stopped", "hold", "quiet", false],
  ] as const)(
    "shows a %s run's state, mark and Stop",
    (name, extra, state, shape, tone, canStop) => {
      const status = name.split(" ")[0] as TrackingDetailRun["status"];
      const row = buildTaskRunRow(buildRun({ status, ...extra }));
      expect(row).toEqual({
        id: "run-1",
        label: "Review PR",
        mark: { shape, tone },
        state,
        canStop,
      });
    },
  );
});

describe("the words of Stop", () => {
  it("says the run was asked to stop, not that it stopped", () => {
    expect(describeRunStopRequested("Review PR")).toBe('Asked "Review PR" to stop.');
  });

  it("cuts a long workflow name", () => {
    const words = describeRunStopRequested("Review every pull request that touches checkout code");
    expect(words.length).toBeLessThan(60);
    expect(words).toContain("…");
  });

  it("gives the reason Stop was refused", () => {
    expect(describeRunStopRefused("Review PR", "The run has already ended.")).toBe(
      'Could not stop "Review PR": The run has already ended.',
    );
  });
});
