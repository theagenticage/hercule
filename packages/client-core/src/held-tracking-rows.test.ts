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
  followTrackingRead,
  isTrackingHandoffAcknowledged,
  recordTrackingHandoff,
  recordTrackingHandoffCommitted,
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
    ...(status === "running" ? { latestLiveRun: latestRun } : {}),
    liveRunIds: status === "running" ? [latestRun.id] : [],
  };
  return buildTrackingRows([task], [], new Map())[0]!;
};

const A = buildRow("a");
const B = buildRow("b");
const C = buildRow("c");

const readIds = (rows: ReadonlyArray<TrackingRow>) => rows.map((row) => row.task.taskId);

describe("followListedTrackingRows", () => {
  it("shows every read as it is while nothing is held", () => {
    const held = followListedTrackingRows(startHeldTrackingRows([A, B]), [B, C], 10);
    expect(readIds(held.shown)).toEqual(["b", "c"]);
  });

  it("keeps the rows shown while holding, and shows the last read once the holding stops", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A, B]), true);
    const finished = buildRow("a", "completed");
    held = followListedTrackingRows(held, [B, finished, C], 10);
    expect(held.shown).toEqual([A, B]);
    held = updateTrackingRowsHolding(held, false);
    expect(held.shown).toEqual([B, finished, C]);
  });

  it("takes a row the user marked done off at once while other changes wait", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A, B]), true);
    held = recordTrackingRowMarkedDone(held, "a");
    held = followListedTrackingRows(held, [B, C], 10);
    expect(readIds(held.shown)).toEqual(["b"]);
    expect(held.markedDoneTaskIds.size).toBe(0);
  });

  it("waits for the read that shows the row gone, and holds nothing back after it", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A, B]), true);
    held = recordTrackingRowMarkedDone(held, "a");
    held = followListedTrackingRows(held, [A, B], 10);
    expect(readIds(held.shown)).toEqual(["a", "b"]);
    expect(held.markedDoneTaskIds.has("a")).toBe(true);
  });

  it("shows the whole read once a read that started after the handoff committed arrives", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A]), true);
    held = recordTrackingHandoffCommitted(recordTrackingHandoff(held, "signal-c"), "signal-c", 100);
    // A read that started before the commit may lack the handoff: it waits.
    held = followListedTrackingRows(held, [A, buildRow("b", "completed")], 90);
    expect(readIds(held.shown)).toEqual(["a"]);
    expect(held.handoffs.has("signal-c")).toBe(true);
    // A read that started after it shows the handoff, and the other changes come with it.
    held = followListedTrackingRows(held, [A, buildRow("b", "completed"), C], 110);
    expect(readIds(held.shown)).toEqual(["a", "b", "c"]);
    expect(held.handoffs.size).toBe(0);
  });

  it("waits while the handoff is still being sent, whatever the read", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A]), true);
    held = recordTrackingHandoff(held, "signal-c");
    held = followListedTrackingRows(held, [A, B], 1_000);
    expect(readIds(held.shown)).toEqual(["a"]);
    expect(held.handoffs.has("signal-c")).toBe(true);
  });
});

describe("a handoff that later handoffs have pushed out of the read", () => {
  /** Builds a finished Task `t`, and the same Task Working with only the newest `count` handoffs listed. */
  const buildWorking = (count: number): TrackingRow => {
    const latest = buildRun("t-latest", "running");
    return buildTrackingRows(
      [
        {
          taskId: "t",
          title: "Task t",
          // The read lists the newest handoffs first, at most ten of them.
          handoffs: Array.from({ length: count }, (_, index) => ({
            signalId: `signal-later-${String(index)}`,
            runId: `run-later-${String(index)}`,
            at: AT,
          })),
          latestRun: latest,
          latestLiveRun: latest,
          liveRunIds: [latest.id],
        },
      ],
      [],
      new Map(),
    )[0]!;
  };
  const finished = buildTrackingRows(
    [
      {
        taskId: "t",
        title: "Task t",
        handoffs: [{ signalId: "signal-t0", runId: "run-t0", at: AT }],
        latestRun: buildRun("t0", "completed"),
        liveRunIds: [],
      },
    ],
    [],
    new Map(),
  )[0]!;

  it.each([1, 10])(
    "applies the user's handoff when a read after its commit lists %s later handoffs and not its own",
    (count) => {
      let held = updateTrackingRowsHolding(startHeldTrackingRows([finished]), true);
      held = recordTrackingHandoffCommitted(
        recordTrackingHandoff(held, "signal-t1"),
        "signal-t1",
        100,
      );
      held = followListedTrackingRows(held, [buildWorking(count)], 150);
      expect(held.listed[0]!.state).toBe("working");
      expect(held.shown[0]!.state).toBe("working");
      expect(held.handoffs.size).toBe(0);
    },
  );

  it("forgets a handoff that still waits when the holding stops", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A]), true);
    held = recordTrackingHandoffCommitted(recordTrackingHandoff(held, "signal-c"), "signal-c", 100);
    held = updateTrackingRowsHolding(held, false);
    expect(held.handoffs.size).toBe(0);
    // A commit that is recorded after that finds nothing to follow.
    expect(recordTrackingHandoffCommitted(held, "signal-c", 200).handoffs.size).toBe(0);
  });
});

describe("dropping the user's own changes", () => {
  it("makes a later change to the row wait again once its mark done failed", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A, B]), true);
    held = dropTrackingRowMarkedDone(recordTrackingRowMarkedDone(held, "a"), "a");
    held = followListedTrackingRows(held, [B], 10);
    expect(readIds(held.shown)).toEqual(["a", "b"]);
  });

  it("makes a row for the signal wait again once its handoff failed", () => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A]), true);
    held = dropTrackingHandoff(recordTrackingHandoff(held, "signal-c"), "signal-c");
    held = followListedTrackingRows(held, [A, C], 10);
    expect(readIds(held.shown)).toEqual(["a"]);
  });
});

describe("followTrackingRead", () => {
  const holdingWithConfirmedHandoff = (committedAt: number | null) => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A]), true);
    held = recordTrackingHandoff(held, "signal-c");
    return committedAt === null
      ? held
      : recordTrackingHandoffCommitted(held, "signal-c", committedAt);
  };

  it("leaves the record as it is for a read that changes no row and acknowledges nothing", () => {
    const held = holdingWithConfirmedHandoff(100);
    expect(followTrackingRead(held, held.listed, 50)).toBe(held);
  });

  it("acknowledges the handoff on a read that changes no row but started after it committed", () => {
    // The first read, which started before the commit, listed a Task that the held rows lack.
    let held = holdingWithConfirmedHandoff(100);
    held = followListedTrackingRows(held, [A, B], 90);
    expect(readIds(held.shown)).toEqual(["a"]);
    // The next read lists the same rows, as the query shares them, and started after the commit.
    held = followTrackingRead(held, held.listed, 120);
    expect(readIds(held.shown)).toEqual(["a", "b"]);
    expect(held.handoffs.size).toBe(0);
  });

  it("counts a read that started at the very moment of the commit as after it", () => {
    let held = holdingWithConfirmedHandoff(100);
    held = followListedTrackingRows(held, [A, B], 90);
    held = followTrackingRead(held, held.listed, 100);
    expect(readIds(held.shown)).toEqual(["a", "b"]);
  });

  it("waits for a handoff that is still being sent, whatever the read", () => {
    const held = holdingWithConfirmedHandoff(null);
    expect(followTrackingRead(held, held.listed, 1_000)).toBe(held);
  });

  it("shows the row a handoff adds when the read that acknowledges it also lists that row", () => {
    const held = followTrackingRead(holdingWithConfirmedHandoff(100), [A, B], 120);
    expect(readIds(held.shown)).toEqual(["a", "b"]);
    expect(held.handoffs.size).toBe(0);
  });
});

describe("isTrackingHandoffAcknowledged", () => {
  const holdingWithHandoffCommittedAt = (committedAt: number) => {
    let held = updateTrackingRowsHolding(startHeldTrackingRows([A]), true);
    held = recordTrackingHandoff(held, "signal-b");
    return recordTrackingHandoffCommitted(held, "signal-b", committedAt);
  };

  it("is false for a read that started before the handoff committed, or while none waits", () => {
    expect(isTrackingHandoffAcknowledged(holdingWithHandoffCommittedAt(100), 99)).toBe(false);
    expect(isTrackingHandoffAcknowledged(startHeldTrackingRows([A]), 1_000)).toBe(false);
  });

  it("is true for a read that started at or after the commit, whether or not it changed a row", () => {
    expect(isTrackingHandoffAcknowledged(holdingWithHandoffCommittedAt(100), 100)).toBe(true);
    expect(isTrackingHandoffAcknowledged(holdingWithHandoffCommittedAt(100), 120)).toBe(true);
  });

  it("is false for a handoff still being sent, whatever the read", () => {
    const held = recordTrackingHandoff(
      updateTrackingRowsHolding(startHeldTrackingRows([A]), true),
      "signal-b",
    );
    expect(isTrackingHandoffAcknowledged(held, 1_000)).toBe(false);
  });
});
