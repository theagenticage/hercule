/**
 * Tests the record behind the rows Tracking shows: which changes wait while
 * the pointer is on the list column, and which apply at once.
 */
import type { TrackingRun, TrackingTask } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  dropTrackingHandoff,
  dropTrackingRowMarkedDone,
  followListedTrackingRows,
  recordTrackingHandoff,
  recordTrackingRowMarkedDone,
  startHeldTrackingRows,
  updateTrackingRowsHolding,
} from "./held-tracking-rows";
import { buildTrackingRows, type TrackingRow } from "./tracking";

const AT = "2026-10-20T09:00:00.000Z";

/** Builds the newest run of the Task `id`, in `status`. */
const buildRun = (id: string, status: TrackingRun["status"]): TrackingRun => ({
  id: `run-${id}`,
  workflowId: null,
  workflowName: "Implement",
  status,
  createdAt: AT,
  ...(status === "completed" ? { finishedAt: AT } : {}),
  awaitedSignalIds: [],
});

/**
 * Builds the row of Tracking for the Task `id`, handed off from the signal
 * `signal-<id>`, with the run of that handoff as its newest run.
 */
const buildRow = (id: string, status: TrackingRun["status"] = "running"): TrackingRow => {
  const latestRun = buildRun(id, status);
  const task: TrackingTask = {
    taskId: id,
    title: `Task ${id}`,
    handoffs: [{ signalId: `signal-${id}`, runId: latestRun.id, at: AT }],
    latestRun,
  };
  return buildTrackingRows([task])[0]!;
};

const A = buildRow("a");
const B = buildRow("b");
const C = buildRow("c");

const readIds = (rows: ReadonlyArray<TrackingRow>) => rows.map((row) => row.task.taskId);

describe("followListedTrackingRows", () => {
  it("shows every read as it is while nothing is held", () => {
    const held = followListedTrackingRows(startHeldTrackingRows([A, B]), [B, C]);
    expect(readIds(held.shown)).toEqual(["b", "c"]);
  });

  it("keeps the rows shown while holding, and shows the last read once the holding stops", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A, B]), true);
    const finished = buildRow("a", "completed");
    held = followListedTrackingRows(held, [B, finished, C]);
    expect(held.shown).toEqual([A, B]);
    held = updateTrackingRowsHolding(held, false);
    expect(held.shown).toEqual([B, finished, C]);
  });

  it("takes a row the user marked done off at once while other changes wait", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A, B]), true);
    held = recordTrackingRowMarkedDone(held, "a");
    held = followListedTrackingRows(held, [B, C]);
    expect(readIds(held.shown)).toEqual(["b"]);
    expect(held.markedDoneTaskIds.size).toBe(0);
  });

  it("waits for the read that shows the row gone, and holds nothing back after it", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A, B]), true);
    held = recordTrackingRowMarkedDone(held, "a");
    held = followListedTrackingRows(held, [A, B]);
    expect(readIds(held.shown)).toEqual(["a", "b"]);
    expect(held.markedDoneTaskIds.has("a")).toBe(true);
  });

  it("shows the whole read once the Task of a signal the user handed off has a row", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A]), true);
    held = recordTrackingHandoff(held, "signal-c");
    held = followListedTrackingRows(held, [A, buildRow("b", "completed")]);
    expect(readIds(held.shown)).toEqual(["a"]);
    held = followListedTrackingRows(held, [A, buildRow("b", "completed"), C]);
    expect(readIds(held.shown)).toEqual(["a", "b", "c"]);
    expect(held.handoffSignalIds.size).toBe(0);
  });
});

describe("a handoff that a later run has superseded", () => {
  it("applies once the read holds its receipt, though another handoff's run is the Task's newest", () => {
    // A finished Task, handed off for the user's signal s1 while the pointer holds the rows.
    const first = buildRun("t1", "completed");
    const finishedTask: TrackingTask = {
      taskId: "t",
      title: "Task t",
      handoffs: [{ signalId: "signal-t0", runId: first.id, at: AT }],
      latestRun: first,
    };
    let held = recordTrackingHandoff(
      updateTrackingRowsHolding(startHeldTrackingRows(buildTrackingRows([finishedTask])), true),
      "signal-t1",
    );

    // Before the first read, another client handed off s2 to the same Task. The read holds both
    // receipts, but only the run of s2 is the Task's newest and live run.
    const second = buildRun("t2", "running");
    held = followListedTrackingRows(
      held,
      buildTrackingRows([
        {
          ...finishedTask,
          handoffs: [
            // The newest handoff first, as the read lists them.
            { signalId: "signal-t2", runId: second.id, at: AT },
            { signalId: "signal-t1", runId: "run-superseded", at: AT },
            ...finishedTask.handoffs,
          ],
          latestRun: second,
          latestLiveRun: second,
        },
      ]),
    );

    expect(held.listed[0]!.state).toBe("working");
    expect(held.shown[0]!.state).toBe("working");
    expect(held.handoffSignalIds.has("signal-t1")).toBe(false);
  });

  it("waits while the read does not hold the receipt yet", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A]), true);
    held = recordTrackingHandoff(held, "signal-c");
    held = followListedTrackingRows(held, [A, B]);
    expect(readIds(held.shown)).toEqual(["a"]);
    expect(held.handoffSignalIds.has("signal-c")).toBe(true);
  });
});

describe("dropping the user's own changes", () => {
  it("makes a later change to the row wait again once its mark done failed", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A, B]), true);
    held = dropTrackingRowMarkedDone(recordTrackingRowMarkedDone(held, "a"), "a");
    held = followListedTrackingRows(held, [B]);
    expect(readIds(held.shown)).toEqual(["a", "b"]);
  });

  it("makes a row for the signal wait again once its handoff failed", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A]), true);
    held = dropTrackingHandoff(recordTrackingHandoff(held, "signal-c"), "signal-c");
    held = followListedTrackingRows(held, [A, C]);
    expect(readIds(held.shown)).toEqual(["a"]);
  });
});
