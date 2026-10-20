import type { Run, RunSummary, Task } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  buildTrackingRows,
  buildTrackingSnapshot,
  canMarkTrackingStateDone,
  countWaitingTrackingRows,
  describeRunFailureCause,
  describeTrackingLine,
  groupTrackingRows,
  isTrackingAffectedByRunPush,
  listRecentTrackingRows,
  type TrackingRow,
  type TrackingState,
} from "./tracking";

const START = "2026-10-20T09:00:00.000Z";
const at = (minutes: number): string =>
  new Date(Date.parse(START) + minutes * 60_000).toISOString();

/** Builds a Task handed off at minute `handedOffAt`, with the given fields changed. */
const buildTask = (id: string, handedOffAt = 0, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  description: "",
  status: "in-progress",
  priority: "normal",
  labels: [],
  provenance: [
    { signalId: `signal-${id}`, runId: `run-${id}`, at: at(handedOffAt), actor: "user" },
  ],
  createdAt: at(handedOffAt),
  updatedAt: at(handedOffAt),
  statusChangedAt: at(handedOffAt),
  ...overrides,
});

const SUMMARY_FIELDS = {
  workflowId: null,
  workflowName: "Implement",
  origin: { kind: "manual", actor: "user" },
} as const;

/** Builds a run of Task `taskId` created at minute `createdAt`, in the given status. */
const buildRun = (
  id: string,
  taskId: string,
  createdAt: number,
  status: "pending" | "running" | "completed" | "failed" | "cancelled",
  overrides: Record<string, unknown> = {},
): RunSummary => {
  const fields = { ...SUMMARY_FIELDS, id, taskId, createdAt: at(createdAt), ...overrides };
  switch (status) {
    case "pending":
      return { ...fields, status };
    case "running":
      return {
        ...fields,
        status,
        startedAt: at(createdAt + 1),
        activeStepIds: ["code"],
        awaitedSignalIds: [],
        ...overrides,
      };
    case "completed":
      return {
        ...fields,
        status,
        startedAt: at(createdAt + 1),
        finishedAt: at(createdAt + 10),
        ...overrides,
      };
    case "failed":
      return {
        ...fields,
        status,
        failureReason: "step-failed",
        failedStepId: "code",
        startedAt: at(createdAt + 1),
        finishedAt: at(createdAt + 10),
        ...overrides,
      };
    case "cancelled":
      return { ...fields, status, finishedAt: at(createdAt + 10), ...overrides };
  }
};

const stateOf = (task: Task, runs: ReadonlyArray<RunSummary>): TrackingState | undefined =>
  buildTrackingRows([task], runs)[0]?.state;

describe("buildTrackingRows", () => {
  const task = buildTask("a");

  it("puts a Task whose last run failed in Failed, even when an older run is live", () => {
    const runs = [buildRun("r1", "a", 0, "running"), buildRun("r2", "a", 5, "failed")];
    expect(stateOf(task, runs)).toBe("failed");
  });

  it("puts a Task with a live run in Working, pending or running", () => {
    expect(stateOf(task, [buildRun("r1", "a", 0, "pending")])).toBe("working");
    expect(stateOf(task, [buildRun("r1", "a", 0, "running")])).toBe("working");
  });

  it("keeps a Task working while an older run is live and the last run completed", () => {
    const runs = [buildRun("r1", "a", 0, "running"), buildRun("r2", "a", 5, "completed")];
    const [row] = buildTrackingRows([task], runs);
    expect(row?.state).toBe("working");
    expect(row?.run.id).toBe("r1");
  });

  it("puts a Task in Finished when no run is live and the last run completed", () => {
    const runs = [buildRun("r1", "a", 0, "failed"), buildRun("r2", "a", 5, "completed")];
    expect(stateOf(task, runs)).toBe("finished");
  });

  it("puts a Task in Stopped when the last run was cancelled", () => {
    const runs = [buildRun("r1", "a", 0, "completed"), buildRun("r2", "a", 5, "cancelled")];
    expect(stateOf(task, runs)).toBe("stopped");
  });

  it("takes the last run as the newest by createdAt, then by id", () => {
    const sameMoment = [buildRun("r1", "a", 0, "failed"), buildRun("r2", "a", 0, "completed")];
    const [row] = buildTrackingRows([task], sameMoment);
    expect(row?.run.id).toBe("r2");
    expect(row?.state).toBe("finished");
  });

  it("leaves out a Task with no run, and reads only the runs of each Task", () => {
    const runs = [buildRun("r1", "b", 0, "failed")];
    expect(buildTrackingRows([task], runs)).toEqual([]);
    expect(buildTrackingRows([task, buildTask("b")], runs).map((row) => row.task.id)).toEqual([
      "b",
    ]);
  });

  it("reads since from when the run ended, or started", () => {
    const since = (run: RunSummary) => buildTrackingRows([task], [run])[0]?.since;
    expect(since(buildRun("r", "a", 0, "failed"))).toBe(at(10));
    expect(since(buildRun("r", "a", 0, "completed"))).toBe(at(10));
    expect(since(buildRun("r", "a", 0, "cancelled"))).toBe(at(10));
    // A live run's row is as old as the run, so pending to running keeps its age.
    expect(since(buildRun("r", "a", 0, "running"))).toBe(at(0));
    expect(since(buildRun("r", "a", 0, "pending"))).toBe(at(0));
  });

  it("orders Failed, Finished, Working, Stopped", () => {
    const tasks = ["stopped", "working", "finished", "failed"].map((id) => buildTask(id));
    const runs = [
      buildRun("r1", "stopped", 0, "cancelled"),
      buildRun("r2", "working", 0, "running"),
      buildRun("r3", "finished", 0, "completed"),
      buildRun("r4", "failed", 0, "failed"),
    ];
    expect(buildTrackingRows(tasks, runs).map((row) => row.task.id)).toEqual([
      "failed",
      "finished",
      "working",
      "stopped",
    ]);
  });

  it("orders a state's rows by the oldest handoff first, reading the Task's latest handoff", () => {
    const old = buildTask("old", 20);
    const middle = buildTask("middle", 30);
    // Handed off at minute 5, then again at minute 40: the latest handoff counts.
    const handedAgain = buildTask("again", 5, {
      provenance: [
        { signalId: "s1", at: at(5), actor: "user" },
        { ref: { system: "linear", id: "PAY-1" }, at: at(25), actor: "system" },
        { signalId: "s2", at: at(40), actor: "user" },
      ],
    } as Partial<Task>);
    const runs = ["old", "middle", "again"].map((id, i) => buildRun(`r${i}`, id, 0, "completed"));
    expect(buildTrackingRows([handedAgain, middle, old], runs).map((row) => row.task.id)).toEqual([
      "old",
      "middle",
      "again",
    ]);
  });
});

describe("listRecentTrackingRows", () => {
  const buildRow = (id: string, minute: number): TrackingRow => {
    const task = buildTask(id);
    return {
      task,
      state: "finished",
      run: buildRun(`r-${id}`, id, 0, "completed"),
      since: at(minute),
    };
  };

  it("lists the two rows that entered their state last, newest first", () => {
    const rows = [buildRow("a", 5), buildRow("b", 30), buildRow("c", 20), buildRow("d", 1)];
    expect(listRecentTrackingRows(rows).map((row) => row.task.id)).toEqual(["b", "c"]);
  });

  it("lists fewer rows when there are fewer, and none for none", () => {
    expect(listRecentTrackingRows([buildRow("a", 5)])).toHaveLength(1);
    expect(listRecentTrackingRows([])).toEqual([]);
  });
});

describe("waiting on the user", () => {
  it("counts the waiting rows", () => {
    const tasks = ["a", "b", "c", "d"].map((id) => buildTask(id));
    const rows = buildTrackingRows(tasks, [
      buildRun("r1", "a", 0, "failed"),
      buildRun("r2", "b", 0, "completed"),
      buildRun("r3", "c", 0, "running"),
      buildRun("r4", "d", 0, "cancelled"),
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

describe("buildTrackingSnapshot", () => {
  it("holds the rows and the ids of every run read, also the runs a row does not hold", () => {
    const task = buildTask("a");
    const runs = [buildRun("r2", "a", 5, "completed"), buildRun("r1", "a", 0, "running")];
    const snapshot = buildTrackingSnapshot([task], runs);
    expect(snapshot.rows).toEqual(buildTrackingRows([task], runs));
    expect(snapshot.runIds).toEqual(["r1", "r2"]);
  });
});

describe("isTrackingAffectedByRunPush", () => {
  const snapshot = buildTrackingSnapshot(
    [buildTask("a")],
    [buildRun("r1", "a", 0, "running"), buildRun("r2", "a", 5, "completed")],
  );

  it("is affected by a push that names a run of the snapshot, even one a row does not hold", () => {
    expect(isTrackingAffectedByRunPush(snapshot, { ids: ["r1"], kind: "updated" })).toBe(true);
    expect(isTrackingAffectedByRunPush(snapshot, { ids: ["x", "r2"], kind: "deleted" })).toBe(true);
  });

  it("is affected by a push that lists no ids, and by the creation of a run, which may be a re-run", () => {
    expect(isTrackingAffectedByRunPush(snapshot, { ids: [], kind: "updated" })).toBe(true);
    expect(isTrackingAffectedByRunPush(snapshot, { ids: ["new"], kind: "created" })).toBe(true);
  });

  it("is not affected by a change to a run of no tracked Task", () => {
    expect(isTrackingAffectedByRunPush(snapshot, { ids: ["x", "y"], kind: "updated" })).toBe(false);
  });
});

const PLAN: Run["plan"] = {
  name: "Investigate",
  triggers: [{ id: "manual", kind: "start", on: { kind: "github.issue.labeled" } }],
  steps: [
    { id: "look", kind: "action", action: "task.create" },
    { id: "fix", kind: "action", action: "task.update" },
  ],
  edges: [{ from: "look", to: "fix" }],
};

const RUN_FIELDS = {
  id: "run-1",
  workflowId: null,
  plan: PLAN,
  inputs: {},
  origin: { kind: "manual", actor: "user" },
  subscriptions: [],
  edgeTraversals: [0],
  createdAt: START,
} as const;

describe("describeRunFailureCause", () => {
  it("reads the error of the step that failed", () => {
    const run = {
      ...RUN_FIELDS,
      status: "failed",
      failureReason: "step-failed",
      failedStepId: "fix",
      startedAt: START,
      finishedAt: at(2),
      steps: [
        {
          stepId: "look",
          iteration: 1,
          status: "completed",
          startedAt: START,
          finishedAt: at(1),
          output: {},
        },
        {
          stepId: "fix",
          iteration: 1,
          status: "failed",
          startedAt: at(1),
          finishedAt: at(2),
          error: { code: "denied", message: "permission denied on ops-db" },
        },
      ],
    } as Run;
    expect(describeRunFailureCause(run)).toBe("permission denied on ops-db");
  });

  it("reads the error of the step's latest failed record", () => {
    const failed = (iteration: number, message: string) => ({
      stepId: "fix",
      iteration,
      status: "failed",
      startedAt: START,
      finishedAt: at(1),
      error: { code: "x", message },
    });
    const run = {
      ...RUN_FIELDS,
      status: "failed",
      failureReason: "step-failed",
      failedStepId: "fix",
      startedAt: START,
      finishedAt: at(2),
      steps: [failed(1, "first try"), failed(2, "second try")],
    } as Run;
    expect(describeRunFailureCause(run)).toBe("second try");
  });

  it("reads the message of a run that did not validate", () => {
    const run = {
      ...RUN_FIELDS,
      status: "failed",
      failureReason: "validation-error",
      failureMessage: "Input ticket is required",
      finishedAt: at(1),
      steps: [],
    } as Run;
    expect(describeRunFailureCause(run)).toBe("Input ticket is required");
  });

  it("reads the message of the edge the run failed at", () => {
    const run = {
      ...RUN_FIELDS,
      status: "failed",
      failureReason: "iteration-limit",
      failedStepId: "look",
      failedEdge: { index: 0, message: "The run would follow look → fix a fourth time." },
      startedAt: START,
      finishedAt: at(1),
      steps: [],
    } as Run;
    expect(describeRunFailureCause(run)).toBe("The run would follow look → fix a fourth time.");
  });

  it("falls back to the failure reason in plain words when no message exists", () => {
    const run = {
      ...RUN_FIELDS,
      status: "failed",
      failureReason: "workspace-failed",
      startedAt: START,
      finishedAt: at(1),
      steps: [],
    } as Run;
    expect(describeRunFailureCause(run)).toBe("workspace failed");
  });

  it("returns nothing for a run that did not fail", () => {
    const run = { ...RUN_FIELDS, status: "pending", steps: [] } as Run;
    expect(describeRunFailureCause(run)).toBeUndefined();
  });
});

describe("describeTrackingLine", () => {
  const rowOf = (run: RunSummary): TrackingRow =>
    buildTrackingRows([buildTask("a")], [run])[0] as TrackingRow;

  it("names the workflow apart from the rest of the line", () => {
    const line = describeTrackingLine(rowOf(buildRun("r", "a", 0, "completed")));
    expect(line).toEqual({ workflowName: "Implement", text: "finished" });
  });

  it("adds why a Failed run failed once it is known, and not before", () => {
    const row = rowOf(buildRun("r", "a", 0, "failed"));
    expect(describeTrackingLine(row).text).toBe("failed");
    expect(describeTrackingLine(row, "permission denied on ops-db").text).toBe(
      "failed · permission denied on ops-db",
    );
  });

  it("says a running or pending run is working", () => {
    expect(describeTrackingLine(rowOf(buildRun("r", "a", 0, "running"))).text).toBe("· working");
    expect(describeTrackingLine(rowOf(buildRun("r", "a", 0, "pending"))).text).toBe("· working");
  });

  it("names the signal triggers a run only waits on", () => {
    const waiting = buildRun("r", "a", 0, "running", {
      activeStepIds: [],
      awaitedSignalIds: ["checks_passed", "pr_merged"],
    });
    expect(describeTrackingLine(rowOf(waiting)).text).toBe(
      "· waiting for checks_passed, pr_merged",
    );
  });

  it("says a cancelled run is stopped", () => {
    expect(describeTrackingLine(rowOf(buildRun("r", "a", 0, "cancelled"))).text).toBe("· stopped");
  });
});

describe("groupTrackingRows", () => {
  it("groups the rows by state in Tracking's order, keeping the order inside a group", () => {
    const tasks = ["w1", "f1", "w2", "s1"].map((id) => buildTask(id));
    const rows = buildTrackingRows(tasks, [
      buildRun("r1", "w1", 0, "running"),
      buildRun("r2", "f1", 0, "failed"),
      buildRun("r3", "w2", 0, "running"),
      buildRun("r4", "s1", 0, "cancelled"),
    ]);
    expect(
      groupTrackingRows(rows).map(({ state, rows: inState }) => [
        state,
        inState.map((row) => row.task.id),
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
