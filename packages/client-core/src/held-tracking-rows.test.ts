/**
 * Tests the record behind the rows Tracking shows: which changes wait while
 * the pointer is on the list column, and which apply at once.
 */
import type { RunSummary, Task } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  dropHandedOff,
  dropMarkedDone,
  followListedTrackingRows,
  recordHandedOff,
  recordMarkedDone,
  startHeldTrackingRows,
  updateTrackingRowsHolding,
} from "./held-tracking-rows";
import type { TrackingRow } from "./tracking";

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

const readIds = (rows: ReadonlyArray<TrackingRow>) => rows.map((row) => row.task.id);

describe("followListedTrackingRows", () => {
  it("shows every read as it is while nothing is held", () => {
    const held = followListedTrackingRows(startHeldTrackingRows([A, B]), [B, C]);
    expect(readIds(held.shown)).toEqual(["b", "c"]);
  });

  it("keeps the rows shown while holding, and shows the last read once the holding stops", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A, B]), true);
    const finished = buildRow("a", "finished");
    held = followListedTrackingRows(held, [B, finished, C]);
    expect(held.shown).toEqual([A, B]);
    held = updateTrackingRowsHolding(held, false);
    expect(held.shown).toEqual([B, finished, C]);
  });

  it("takes a row the user marked done off at once while other changes wait", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A, B]), true);
    held = recordMarkedDone(held, "a");
    held = followListedTrackingRows(held, [B, C]);
    expect(readIds(held.shown)).toEqual(["b"]);
    expect(held.markedDoneTaskIds.size).toBe(0);
  });

  it("waits for the read that shows the row gone, and holds nothing back after it", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A, B]), true);
    held = recordMarkedDone(held, "a");
    held = followListedTrackingRows(held, [A, B]);
    expect(readIds(held.shown)).toEqual(["a", "b"]);
    expect(held.markedDoneTaskIds.has("a")).toBe(true);
  });

  it("shows the whole read once the Task of a signal the user handed off has a row", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A]), true);
    held = recordHandedOff(held, "signal-c");
    held = followListedTrackingRows(held, [A, buildRow("b", "finished")]);
    expect(readIds(held.shown)).toEqual(["a"]);
    held = followListedTrackingRows(held, [A, buildRow("b", "finished"), C]);
    expect(readIds(held.shown)).toEqual(["a", "b", "c"]);
    expect(held.handedOffSignalIds.size).toBe(0);
  });
});

describe("dropping the user's own changes", () => {
  it("makes a later change to the row wait again once its mark done failed", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A, B]), true);
    held = dropMarkedDone(recordMarkedDone(held, "a"), "a");
    held = followListedTrackingRows(held, [B]);
    expect(readIds(held.shown)).toEqual(["a", "b"]);
  });

  it("makes a row for the signal wait again once its handoff failed", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A]), true);
    held = dropHandedOff(recordHandedOff(held, "signal-c"), "signal-c");
    held = followListedTrackingRows(held, [A, C]);
    expect(readIds(held.shown)).toEqual(["a"]);
  });
});
