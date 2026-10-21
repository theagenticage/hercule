/** Tests how Your work is described for the pane and for a signal's row. */
import type { Signal, Task, TrackingRun, TrackingTask } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildTrackingRows, type TrackingRow } from "./tracking";
import { describeYourWork, describeYourWorkOnRow } from "./your-work-display";

const AT = "2026-10-20T09:00:00.000Z";

const SIGNAL: Signal = {
  id: "signal-1",
  kind: "github/checks-failed",
  origin: { type: "api", actor: "user", eventIds: [], reason: "Test" },
  title: "Checks failed",
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: AT,
};

const buildTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  description: "",
  status: "open",
  priority: "normal",
  labels: [],
  provenance: [],
  createdAt: AT,
  updatedAt: AT,
  statusChangedAt: AT,
  ...overrides,
});

/** Builds the row of Tracking for the Task `taskId`, whose newest run has `status`. */
const buildRow = (
  taskId: string,
  status: TrackingRun["status"],
  workflowId: string | null = "wf-1",
): TrackingRow => {
  const latestRun: TrackingRun = {
    id: `run-${taskId}`,
    workflowId,
    workflowName: "Fix bug",
    status,
    createdAt: AT,
    awaitedSignalIds: [],
  };
  const tracked: TrackingTask = {
    taskId,
    title: `Task ${taskId}`,
    handoffs: [{ signalId: "s", runId: latestRun.id, at: AT }],
    latestRun,
    ...(status === "running" ? { latestLiveRun: latestRun } : {}),
  };
  return buildTrackingRows([tracked], { requests: [], signals: [], yourWork: new Map() })[0]!;
};

describe("describeYourWork", () => {
  it("describes a Task with a row of Tracking by its agent's face and its row's state", () => {
    expect(describeYourWork([buildTask("a")], [buildRow("a", "failed")])).toEqual([
      {
        kind: "tracked",
        taskId: "a",
        title: "Task a",
        faceSeed: "wf-1",
        state: "failed",
        settledPose: null,
        stateWord: "failed",
        waitsOnYou: true,
      },
    ]);
  });

  it("says a row that does not wait on the user does not", () => {
    const [item] = describeYourWork([buildTask("a")], [buildRow("a", "running")]);
    expect(item).toMatchObject({ kind: "tracked", stateWord: "working", waitsOnYou: false });
  });

  it("shows the agent as its last run left it when the row waits on a signal, not waiting", () => {
    const tasks = [buildTask("a")];
    const waitsOnSignal = (status: TrackingRun["status"]): TrackingRow => ({
      ...buildRow("a", status),
      state: "needs-you",
      waitsOn: { kind: "signal", signal: SIGNAL },
    });
    expect(describeYourWork(tasks, [waitsOnSignal("failed")])[0]).toMatchObject({
      settledPose: "failed",
      stateWord: "needs you",
      waitsOnYou: true,
    });
    expect(describeYourWork(tasks, [waitsOnSignal("completed")])[0]).toMatchObject({
      settledPose: "done",
    });
  });

  it("describes a Task with no row by its status, whichever open status it has", () => {
    expect(
      describeYourWork(
        [buildTask("a"), buildTask("b", { status: "in-progress" })],
        [buildRow("other", "failed")],
      ),
    ).toEqual([
      { kind: "untracked", taskId: "a", title: "Task a", statusWord: "Open" },
      { kind: "untracked", taskId: "b", title: "Task b", statusWord: "In progress" },
    ]);
  });

  it("keeps the order of the Tasks", () => {
    const items = describeYourWork(
      [buildTask("b"), buildTask("a")],
      [buildRow("a", "failed"), buildRow("b", "failed")],
    );
    expect(items.map((item) => item.taskId)).toEqual(["b", "a"]);
  });
});

describe("describeYourWorkOnRow", () => {
  it("returns null for a signal with no Your work", () => {
    expect(describeYourWorkOnRow([], [buildRow("a", "failed")])).toBeNull();
  });

  it("leads with the face of the first tracked Task, and the title of the first Task whichever it is", () => {
    const rows = [buildRow("b", "failed", "wf-b"), buildRow("c", "failed", "wf-c")];
    expect(describeYourWorkOnRow([buildTask("a"), buildTask("b"), buildTask("c")], rows)).toEqual({
      faceSeed: "wf-b",
      firstTaskTitle: "Task a",
    });
  });

  it("has no face when no Task is tracked", () => {
    expect(describeYourWorkOnRow([buildTask("a")], [])).toEqual({
      faceSeed: null,
      firstTaskTitle: "Task a",
    });
  });
});
