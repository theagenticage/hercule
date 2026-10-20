import type { TrackingRun, TrackingTask } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  buildTrackingRows,
  canMarkTrackingStateDone,
  countWaitingTrackingRows,
  describeTrackingLine,
  groupTrackingRows,
  isTrackingAffectedByRunPush,
  listRecentTrackingRows,
  type TrackingState,
} from "./tracking";

const START = "2026-10-20T09:00:00.000Z";
const at = (minutes: number): string =>
  new Date(Date.parse(START) + minutes * 60_000).toISOString();

type RunStatus = TrackingRun["status"];

/** Builds a run created at minute `createdAt`, in the given status, with the fields of `overrides`. */
const buildRun = (
  id: string,
  createdAt: number,
  status: RunStatus,
  overrides: Partial<TrackingRun> = {},
): TrackingRun => ({
  id,
  workflowId: null,
  workflowName: "Implement",
  status,
  createdAt: at(createdAt),
  ...(status === "pending" ? {} : { startedAt: at(createdAt + 1) }),
  ...(status === "completed" || status === "failed" || status === "cancelled"
    ? { finishedAt: at(createdAt + 10) }
    : {}),
  awaitedSignalIds: [],
  ...overrides,
});

/** Builds a tracked Task handed off at minute `handedOffAt`, with its newest run and its newest live run. */
const buildTask = (
  taskId: string,
  latestRun: TrackingRun,
  { handedOffAt = 0, latestLiveRun }: { handedOffAt?: number; latestLiveRun?: TrackingRun } = {},
): TrackingTask => ({
  taskId,
  title: `Task ${taskId}`,
  handoffs: [{ signalId: `signal-${taskId}`, runId: latestRun.id, at: at(handedOffAt) }],
  latestRun,
  ...(latestLiveRun === undefined ? {} : { latestLiveRun }),
});

const stateOf = (task: TrackingTask): TrackingState | undefined =>
  buildTrackingRows([task])[0]?.state;

describe("buildTrackingRows", () => {
  it("puts a Task whose newest run failed in Failed, even when an older run is live", () => {
    const task = buildTask("a", buildRun("r2", 5, "failed"), {
      latestLiveRun: buildRun("r1", 0, "running"),
    });
    expect(stateOf(task)).toBe("failed");
    expect(buildTrackingRows([task])[0]?.run.id).toBe("r2");
  });

  it("puts a Task with a live run in Working, pending or running", () => {
    expect(stateOf(buildTask("a", buildRun("r1", 0, "pending")))).toBe("working");
    expect(stateOf(buildTask("a", buildRun("r1", 0, "running")))).toBe("working");
  });

  it("keeps a Task working while an older run is live and the newest run completed, and reads the live run", () => {
    const live = buildRun("r1", 0, "running");
    const [row] = buildTrackingRows([
      buildTask("a", buildRun("r2", 5, "completed"), { latestLiveRun: live }),
    ]);
    expect(row?.state).toBe("working");
    expect(row?.run.id).toBe("r1");
  });

  it("puts a Task in Finished when no run is live and the newest run completed", () => {
    expect(stateOf(buildTask("a", buildRun("r2", 5, "completed")))).toBe("finished");
  });

  it("puts a Task in Stopped when the newest run was cancelled", () => {
    expect(stateOf(buildTask("a", buildRun("r2", 5, "cancelled")))).toBe("stopped");
  });

  it("reads since from when the run ended, or when a live run was created", () => {
    const since = (run: TrackingRun) => buildTrackingRows([buildTask("a", run)])[0]?.since;
    expect(since(buildRun("r", 0, "failed"))).toBe(at(10));
    expect(since(buildRun("r", 0, "completed"))).toBe(at(10));
    expect(since(buildRun("r", 0, "cancelled"))).toBe(at(10));
    // A live run's row is as old as the run, so pending to running keeps its age.
    expect(since(buildRun("r", 0, "running"))).toBe(at(0));
    expect(since(buildRun("r", 0, "pending"))).toBe(at(0));
  });

  it("orders Failed, Finished, Working, Stopped", () => {
    const rows = buildTrackingRows([
      buildTask("stopped", buildRun("r1", 0, "cancelled")),
      buildTask("working", buildRun("r2", 0, "running")),
      buildTask("finished", buildRun("r3", 0, "completed")),
      buildTask("failed", buildRun("r4", 0, "failed")),
    ]);
    expect(rows.map((row) => row.task.taskId)).toEqual([
      "failed",
      "finished",
      "working",
      "stopped",
    ]);
  });

  it("orders a state's rows by the oldest handoff first, reading the Task's newest handoff", () => {
    // Handed off at minute 5, then again at minute 40: the newest handoff counts.
    const again: TrackingTask = {
      ...buildTask("again", buildRun("r3", 0, "completed"), { handedOffAt: 5 }),
      handoffs: [
        { signalId: "s1", runId: "r0", at: at(5) },
        { signalId: "s2", runId: "r3", at: at(40) },
      ],
    };
    const rows = buildTrackingRows([
      again,
      buildTask("middle", buildRun("r2", 0, "completed"), { handedOffAt: 30 }),
      buildTask("old", buildRun("r1", 0, "completed"), { handedOffAt: 20 }),
    ]);
    expect(rows.map((row) => row.task.taskId)).toEqual(["old", "middle", "again"]);
  });
});

describe("listRecentTrackingRows", () => {
  const buildRow = (id: string, minute: number) =>
    buildTrackingRows([buildTask(id, buildRun(`r-${id}`, minute - 10, "completed"))])[0]!;

  it("lists the two rows that entered their state last, newest first", () => {
    const rows = [buildRow("a", 5), buildRow("b", 30), buildRow("c", 20), buildRow("d", 1)];
    expect(listRecentTrackingRows(rows).map((row) => row.task.taskId)).toEqual(["b", "c"]);
  });

  it("lists fewer rows when there are fewer, and none for none", () => {
    expect(listRecentTrackingRows([buildRow("a", 5)])).toHaveLength(1);
    expect(listRecentTrackingRows([])).toEqual([]);
  });
});

describe("waiting on the user", () => {
  it("counts the waiting rows", () => {
    const rows = buildTrackingRows([
      buildTask("a", buildRun("r1", 0, "failed")),
      buildTask("b", buildRun("r2", 0, "completed")),
      buildTask("c", buildRun("r3", 0, "running")),
      buildTask("d", buildRun("r4", 0, "cancelled")),
    ]);
    expect(countWaitingTrackingRows(rows)).toBe(2);
    expect(countWaitingTrackingRows([])).toBe(0);
  });

  it("lets Finished, Failed and Stopped rows be marked done, and never a Working one", () => {
    expect(canMarkTrackingStateDone("finished")).toBe(true);
    expect(canMarkTrackingStateDone("failed")).toBe(true);
    expect(canMarkTrackingStateDone("stopped")).toBe(true);
    expect(canMarkTrackingStateDone("working")).toBe(false);
  });
});

describe("isTrackingAffectedByRunPush", () => {
  const rows = buildTrackingRows([
    buildTask("a", buildRun("r2", 5, "completed"), { latestLiveRun: buildRun("r1", 0, "running") }),
  ]);

  it("is affected by a push that names a row's newest run or newest live run", () => {
    expect(isTrackingAffectedByRunPush(rows, { ids: ["r1"], kind: "updated" })).toBe(true);
    expect(isTrackingAffectedByRunPush(rows, { ids: ["x", "r2"], kind: "deleted" })).toBe(true);
  });

  it("is affected by a push that lists no ids, and by the creation of a run, which may be a re-run", () => {
    expect(isTrackingAffectedByRunPush(rows, { ids: [], kind: "updated" })).toBe(true);
    expect(isTrackingAffectedByRunPush(rows, { ids: ["new"], kind: "created" })).toBe(true);
  });

  it("is not affected by a change to a run no row holds", () => {
    expect(isTrackingAffectedByRunPush(rows, { ids: ["x", "y"], kind: "updated" })).toBe(false);
    expect(isTrackingAffectedByRunPush([], { ids: ["x"], kind: "updated" })).toBe(false);
  });
});

describe("describeTrackingLine", () => {
  const rowOf = (run: TrackingRun) => buildTrackingRows([buildTask("a", run)])[0]!;

  it("names the workflow apart from the rest of the line", () => {
    expect(describeTrackingLine(rowOf(buildRun("r", 0, "completed")))).toEqual({
      workflowName: "Implement",
      text: "finished",
    });
  });

  it("says why a Failed run failed, and only that it failed when it carries no cause", () => {
    expect(describeTrackingLine(rowOf(buildRun("r", 0, "failed"))).text).toBe("failed");
    const withCause = buildRun("r", 0, "failed", { failureCause: "permission denied on ops-db" });
    expect(describeTrackingLine(rowOf(withCause)).text).toBe(
      "failed · permission denied on ops-db",
    );
  });

  it("says a running or pending run is working", () => {
    expect(describeTrackingLine(rowOf(buildRun("r", 0, "running"))).text).toBe("· working");
    expect(describeTrackingLine(rowOf(buildRun("r", 0, "pending"))).text).toBe("· working");
  });

  it("names the signal triggers a run only waits on", () => {
    const waiting = buildRun("r", 0, "running", {
      awaitedSignalIds: ["checks_passed", "pr_merged"],
    });
    expect(describeTrackingLine(rowOf(waiting)).text).toBe(
      "· waiting for checks_passed, pr_merged",
    );
  });

  it("says a cancelled run is stopped", () => {
    expect(describeTrackingLine(rowOf(buildRun("r", 0, "cancelled"))).text).toBe("· stopped");
  });
});

describe("groupTrackingRows", () => {
  it("groups the rows by state in Tracking's order, keeping the order inside a group", () => {
    const rows = buildTrackingRows([
      buildTask("w1", buildRun("r1", 0, "running"), { handedOffAt: 1 }),
      buildTask("f1", buildRun("r2", 0, "failed")),
      buildTask("w2", buildRun("r3", 0, "running"), { handedOffAt: 2 }),
      buildTask("s1", buildRun("r4", 0, "cancelled")),
    ]);
    expect(
      groupTrackingRows(rows).map(({ state, rows: inState }) => [
        state,
        inState.map((row) => row.task.taskId),
      ]),
    ).toEqual([
      ["failed", ["f1"]],
      ["working", ["w1", "w2"]],
      ["stopped", ["s1"]],
    ]);
  });

  it("returns no group for no row", () => {
    expect(groupTrackingRows([])).toEqual([]);
  });
});
