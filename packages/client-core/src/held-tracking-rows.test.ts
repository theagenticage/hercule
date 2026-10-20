/**
 * Tests the record behind the rows Tracking shows: which changes wait while
 * the pointer is on the list column, and which apply at once.
 */
import type { RunSummary, Task } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  dropTrackingHandoff,
  dropTrackingRowMarkedDone,
  followTrackingSnapshot,
  recordTrackingHandoff,
  recordTrackingRowMarkedDone,
  startHeldTrackingRows,
  updateTrackingRowsHolding,
} from "./held-tracking-rows";
import type { TrackingRow, TrackingSnapshot } from "./tracking";

const AT = "2026-10-20T09:00:00.000Z";

/** Builds a row of Tracking for the Task `id`, handed off from the signal `signal-<id>`. */
const buildRow = (id: string, state: TrackingRow["state"] = "working"): TrackingRow => {
  const task: Task = {
    id,
    title: `Task ${id}`,
    description: "",
    status: "in-progress",
    priority: "normal",
    labels: [],
    provenance: [{ signalId: `signal-${id}`, runId: `run-${id}`, at: AT, actor: "user" }],
    createdAt: AT,
    updatedAt: AT,
    statusChangedAt: AT,
  };
  const run = {
    id: `run-${id}`,
    taskId: id,
    workflowId: null,
    workflowName: "Implement",
    origin: { kind: "manual", actor: "user" },
    createdAt: AT,
    status: "pending",
  } satisfies RunSummary;
  return { task, state, run, since: AT };
};

const A = buildRow("a");
const B = buildRow("b");
const C = buildRow("c");

/** Returns the snapshot of `rows`, which holds the run each row holds. */
const snapshotOf = (...rows: ReadonlyArray<TrackingRow>): TrackingSnapshot => ({
  rows,
  runIds: rows.map((row) => row.run.id),
});

const readIds = (rows: ReadonlyArray<TrackingRow>) => rows.map((row) => row.task.id);

describe("followTrackingSnapshot", () => {
  it("shows every read as it is while nothing is held", () => {
    const held = followTrackingSnapshot(startHeldTrackingRows(snapshotOf(A, B)), snapshotOf(B, C));
    expect(readIds(held.shown)).toEqual(["b", "c"]);
  });

  it("keeps the rows shown while holding, and shows the last read once the holding stops", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows(snapshotOf(A, B)), true);
    const finished = buildRow("a", "finished");
    held = followTrackingSnapshot(held, snapshotOf(B, finished, C));
    expect(held.shown).toEqual([A, B]);
    held = updateTrackingRowsHolding(held, false);
    expect(held.shown).toEqual([B, finished, C]);
  });

  it("takes a row the user marked done off at once while other changes wait", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows(snapshotOf(A, B)), true);
    held = recordTrackingRowMarkedDone(held, "a");
    held = followTrackingSnapshot(held, snapshotOf(B, C));
    expect(readIds(held.shown)).toEqual(["b"]);
    expect(held.markedDoneTaskIds.size).toBe(0);
  });

  it("waits for the read that shows the row gone, and holds nothing back after it", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows(snapshotOf(A, B)), true);
    held = recordTrackingRowMarkedDone(held, "a");
    held = followTrackingSnapshot(held, snapshotOf(A, B));
    expect(readIds(held.shown)).toEqual(["a", "b"]);
    expect(held.markedDoneTaskIds.has("a")).toBe(true);
  });

  it("shows the whole read once the Task of a signal the user handed off has a row", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows(snapshotOf(A)), true);
    held = recordTrackingHandoff(held, "signal-c");
    held = followTrackingSnapshot(held, snapshotOf(A, buildRow("b", "finished")));
    expect(readIds(held.shown)).toEqual(["a"]);
    held = followTrackingSnapshot(held, snapshotOf(A, buildRow("b", "finished"), C));
    expect(readIds(held.shown)).toEqual(["a", "b", "c"]);
    expect(held.handoffSignalIds.size).toBe(0);
  });
});

describe("a handoff whose run the read has not brought yet", () => {
  it("waits for the run the handoff entry names, though the Task already has a row", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows(snapshotOf(A)), true);
    held = recordTrackingHandoff(held, "signal-c");
    // The Task's entry for the signal is read, but the read of the runs came first and lacks its run.
    const early: TrackingSnapshot = { rows: [A, C], runIds: [A.run.id] };
    held = followTrackingSnapshot(held, early);
    expect(readIds(held.shown)).toEqual(["a"]);
    expect(held.handoffSignalIds.has("signal-c")).toBe(true);
    held = followTrackingSnapshot(held, snapshotOf(A, C));
    expect(readIds(held.shown)).toEqual(["a", "c"]);
  });
});

describe("dropping the user's own changes", () => {
  it("makes a later change to the row wait again once its mark done failed", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows(snapshotOf(A, B)), true);
    held = dropTrackingRowMarkedDone(recordTrackingRowMarkedDone(held, "a"), "a");
    held = followTrackingSnapshot(held, snapshotOf(B));
    expect(readIds(held.shown)).toEqual(["a", "b"]);
  });

  it("makes a row for the signal wait again once its handoff failed", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows(snapshotOf(A)), true);
    held = dropTrackingHandoff(recordTrackingHandoff(held, "signal-c"), "signal-c");
    held = followTrackingSnapshot(held, snapshotOf(A, C));
    expect(readIds(held.shown)).toEqual(["a"]);
  });
});
