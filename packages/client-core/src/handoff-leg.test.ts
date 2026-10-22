import type { HandoffLeg, Signal, TrackingRun } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { describeHandoffTrip, isAnyLegAffectedByRunPush } from "./handoff-leg";
import { buildTrackingRows, type TrackingRow } from "./tracking";
import type { YourWork } from "./your-work";

const AT = "2026-10-20T09:00:00.000Z";

type RunStatus = TrackingRun["status"];

const buildRun = (id: string, status: RunStatus, workflowName = "Implement"): TrackingRun => ({
  id,
  workflowId: null,
  workflowName,
  status,
  createdAt: AT,
  awaitedSignalIds: [],
});

/** Builds the signal "sig", resolved by a handoff that started `runId`. */
const buildSignal = (runId: string | null = "run-1"): Signal => ({
  id: "sig",
  kind: "github/checks-failed",
  origin: { type: "api", actor: "user", eventIds: [], reason: "Test" },
  title: "Signal",
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "resolved",
  ...(runId === null
    ? {}
    : {
        resolution: {
          kind: "decided",
          runId,
          outcome: "Handed to an agent",
          actor: "user",
          origin: "web",
          at: AT,
        },
      }),
  createdAt: AT,
});

/** Builds a leg of the signal "sig" on the Task "task": an in-progress Task whose handoff run finished. */
const buildLeg = (overrides: Partial<HandoffLeg> = {}): HandoffLeg => ({
  runId: "run-1",
  signalId: "sig",
  taskId: "task",
  taskStatus: "in-progress",
  workflowId: null,
  workflowName: "Implement",
  rerunCount: 0,
  latestRun: buildRun("run-1", "completed"),
  liveRunIds: [],
  ...overrides,
});

/** Builds Your work with one open signal that names the Task `taskId`. */
const buildYourWorkAbout = (taskId: string): YourWork =>
  new Map([
    [
      "alert",
      {
        signal: { ...buildSignal(null), id: "alert", status: "open" },
        tasks: [
          { id: taskId, title: "Task", status: "in-progress", updatedAt: AT, signalIds: ["alert"] },
        ],
      },
    ],
  ]);

/**
 * Builds the Tracking row of the Task "task" whose newest handoff started
 * `handoffRunId`. The row is in the state of its newest run, or Needs you
 * when `needsYou` is set, as a live run with an open Request makes it.
 */
const buildRow = (
  status: RunStatus,
  { handoffRunId = "run-1", needsYou = false, signalWaits = false } = {},
): TrackingRow => {
  const run = buildRun("run-1", status);
  const live = status === "pending" || status === "running";
  const [row] = buildTrackingRows(
    [
      {
        taskId: "task",
        title: "Task",
        handoffs: [{ signalId: "sig", runId: handoffRunId, at: AT }],
        latestRun: run,
        ...(live ? { latestLiveRun: run } : {}),
        liveRunIds: live ? [run.id] : [],
      },
    ],
    needsYou
      ? [
          {
            sessionId: "s",
            runId: "run-1",
            stepId: "implement",
            title: "Implement",
            question: "Run git push?",
            activityAt: AT,
          },
        ]
      : [],
    signalWaits ? buildYourWorkAbout("task") : new Map(),
  );
  if (row === undefined) throw new Error("no row");
  return row;
};

describe("describeHandoffTrip", () => {
  describe("the trips Done draws (tracking-data.js DONE)", () => {
    it("Task working: Handed to Fix bug -> working", () => {
      const leg = buildLeg({
        workflowName: "Fix bug",
        latestRun: buildRun("run-1", "running"),
        liveRunIds: ["run-1"],
      });
      const trip = describeHandoffTrip(buildSignal(), leg, buildRow("running"));
      expect(trip).toMatchObject({
        steps: ["Handed to Fix bug"],
        end: { text: "working", tone: null },
        pose: "working",
        destination: { kind: "tracking", taskId: "task" },
      });
    });

    it("Task needing you by a Request on a live run: Handed to Implement -> needs you", () => {
      const leg = buildLeg({
        latestRun: buildRun("run-1", "running"),
        liveRunIds: ["run-1"],
      });
      const trip = describeHandoffTrip(buildSignal(), leg, buildRow("running", { needsYou: true }));
      expect(trip).toMatchObject({
        steps: ["Handed to Implement"],
        end: { text: "needs you", tone: "waits" },
        pose: "waiting",
        destination: { kind: "tracking", taskId: "task" },
      });
    });

    it("Task failed: Handed to Investigate -> failed (the same word is said once)", () => {
      const leg = buildLeg({
        workflowName: "Investigate",
        latestRun: buildRun("run-1", "failed"),
      });
      const trip = describeHandoffTrip(buildSignal(), leg, buildRow("failed"));
      expect(trip).toMatchObject({
        steps: ["Handed to Investigate"],
        end: { text: "failed", tone: "waits" },
        pose: "failed",
      });
    });

    it("Task finished: Handed to Review PR -> finished, in the finished tone", () => {
      const leg = buildLeg({ workflowName: "Review PR" });
      const trip = describeHandoffTrip(buildSignal(), leg, buildRow("completed"));
      expect(trip).toMatchObject({
        steps: ["Handed to Review PR"],
        end: { text: "finished", tone: "finished" },
        pose: "done",
      });
    });

    it("Task stopped: Handed to Implement -> stopped", () => {
      const leg = buildLeg({ latestRun: buildRun("run-1", "cancelled") });
      const trip = describeHandoffTrip(buildSignal(), leg, buildRow("cancelled"));
      expect(trip).toMatchObject({
        steps: ["Handed to Implement"],
        end: { text: "stopped", tone: null },
        pose: "idle",
      });
    });

    it("run ended, Task needs you: Handed to Implement -> finished -> needs you", () => {
      const trip = describeHandoffTrip(
        buildSignal(),
        buildLeg(),
        buildRow("completed", { signalWaits: true }),
      );
      expect(trip).toMatchObject({
        steps: ["Handed to Implement", "finished"],
        end: { text: "needs you", tone: "waits" },
        pose: "done",
        destination: { kind: "tracking", taskId: "task" },
      });
    });

    it("re-run once, Task done: Handed to Fix bug -> tried again once -> done", () => {
      const leg = buildLeg({
        workflowName: "Fix bug",
        taskStatus: "done",
        rerunCount: 1,
        latestRun: buildRun("run-2", "completed"),
      });
      const trip = describeHandoffTrip(buildSignal(), leg, undefined);
      expect(trip).toMatchObject({
        steps: ["Handed to Fix bug", "tried again once"],
        end: { text: "done", tone: null },
        pose: "done",
        destination: { kind: "run", runId: "run-2" },
      });
    });

    it("handed on: Handed to Implement -> finished -> continued: Fix bug", () => {
      const leg = buildLeg({
        next: { signalId: "sig-2", runId: "run-9", at: AT, workflowName: "Fix bug" },
      });
      const trip = describeHandoffTrip(
        buildSignal(),
        leg,
        buildRow("running", { handoffRunId: "run-9" }),
      );
      expect(trip).toMatchObject({
        steps: ["Handed to Implement", "finished"],
        end: { text: "continued: Fix bug", tone: null },
        pose: "done",
        destination: { kind: "run", runId: "run-1" },
      });
    });
  });

  describe("edge cases", () => {
    it("says a live earlier leg is still working", () => {
      const leg = buildLeg({
        latestRun: buildRun("run-1", "running"),
        liveRunIds: ["run-1"],
        next: { signalId: "sig-2", runId: "run-9", at: AT, workflowName: "Fix bug" },
      });
      const trip = describeHandoffTrip(buildSignal(), leg, undefined);
      expect(trip).toMatchObject({
        steps: ["Handed to Implement", "working"],
        end: { text: "continued: Fix bug" },
        pose: "working",
      });
    });

    it("ends an in-progress Task with no row on the leg's standing, and opens the run", () => {
      const leg = buildLeg({ latestRun: buildRun("run-1", "failed") });
      const trip = describeHandoffTrip(buildSignal(), leg, undefined);
      expect(trip).toMatchObject({
        steps: ["Handed to Implement"],
        end: { text: "failed", tone: null },
        pose: "failed",
        destination: { kind: "run", runId: "run-1" },
      });
    });

    it("ignores a row of another Task", () => {
      const row = {
        ...buildRow("completed"),
        task: { ...buildRow("completed").task, taskId: "other" },
      };
      const trip = describeHandoffTrip(buildSignal(), buildLeg(), row);
      expect(trip?.end).toEqual({ text: "finished", tone: null });
      expect(trip?.destination).toEqual({ kind: "run", runId: "run-1" });
    });

    it("ignores a row that already holds a newer handoff", () => {
      const trip = describeHandoffTrip(
        buildSignal(),
        buildLeg(),
        buildRow("running", { handoffRunId: "run-9" }),
      );
      expect(trip?.steps).toEqual(["Handed to Implement"]);
      expect(trip?.end).toEqual({ text: "finished", tone: null });
      expect(trip?.pose).toBe("done");
      expect(trip?.destination).toEqual({ kind: "run", runId: "run-1" });
    });

    it("ends an open Task on the leg's standing even when a row is held", () => {
      const trip = describeHandoffTrip(
        buildSignal(),
        buildLeg({ taskStatus: "open" }),
        buildRow("completed"),
      );
      expect(trip?.end).toEqual({ text: "finished", tone: null });
      expect(trip?.destination).toEqual({ kind: "run", runId: "run-1" });
    });

    it("says done for a done Task whose run is still live", () => {
      const leg = buildLeg({
        taskStatus: "done",
        latestRun: buildRun("run-1", "running"),
        liveRunIds: ["run-1"],
      });
      const trip = describeHandoffTrip(buildSignal(), leg, undefined);
      expect(trip).toMatchObject({
        steps: ["Handed to Implement"],
        end: { text: "done" },
        pose: "done",
      });
    });

    it("says cancelled for a cancelled Task, with an idle face", () => {
      const trip = describeHandoffTrip(
        buildSignal(),
        buildLeg({ taskStatus: "cancelled" }),
        undefined,
      );
      expect(trip).toMatchObject({ end: { text: "cancelled" }, pose: "idle" });
    });

    it("counts re-runs in words, then in numbers", () => {
      const steps = (rerunCount: number) =>
        describeHandoffTrip(buildSignal(), buildLeg({ rerunCount, taskStatus: "done" }), undefined)
          ?.steps;
      expect(steps(2)).toEqual(["Handed to Implement", "tried again twice"]);
      expect(steps(3)).toEqual(["Handed to Implement", "tried again 3 times"]);
    });

    it("draws the face from the workflow id, else its name", () => {
      expect(
        describeHandoffTrip(buildSignal(), buildLeg({ workflowId: "wf-1" }), undefined)?.faceSeed,
      ).toBe("wf-1");
      expect(describeHandoffTrip(buildSignal(), buildLeg(), undefined)?.faceSeed).toBe("Implement");
    });

    it("draws the face of the leg's standing: a stopped leg is idle", () => {
      const leg = buildLeg({ latestRun: buildRun("run-1", "cancelled") });
      expect(describeHandoffTrip(buildSignal(), leg, undefined)?.pose).toBe("idle");
    });

    it("treats a failed newest run as failed even while an older run of the leg is live", () => {
      const leg = buildLeg({ latestRun: buildRun("run-2", "failed"), liveRunIds: ["run-1"] });
      expect(describeHandoffTrip(buildSignal(), leg, undefined)?.end.text).toBe("failed");
    });
  });

  describe("returns null", () => {
    it("without a leg", () => {
      expect(describeHandoffTrip(buildSignal(), undefined, undefined)).toBeNull();
    });

    it("for the leg of another signal", () => {
      expect(
        describeHandoffTrip(buildSignal(), buildLeg({ signalId: "other" }), undefined),
      ).toBeNull();
    });

    it("for a leg of another run than the signal's resolution", () => {
      expect(describeHandoffTrip(buildSignal("run-5"), buildLeg(), undefined)).toBeNull();
    });

    it("for a signal whose resolution started no run", () => {
      expect(describeHandoffTrip(buildSignal(null), buildLeg(), undefined)).toBeNull();
    });
  });
});

describe("isAnyLegAffectedByRunPush", () => {
  const legs = [
    buildLeg({ latestRun: buildRun("run-1", "running"), liveRunIds: ["run-1", "run-0"] }),
    buildLeg({ runId: "run-3", latestRun: buildRun("run-4", "completed") }),
  ];

  it("is true when the push lists no ids", () => {
    expect(isAnyLegAffectedByRunPush(legs, { ids: [], kind: "updated" })).toBe(true);
  });

  it("is true for a created run, even when it names no held run", () => {
    expect(isAnyLegAffectedByRunPush(legs, { ids: ["run-new"], kind: "created" })).toBe(true);
  });

  it("is true when a push names the newest run of a leg", () => {
    expect(isAnyLegAffectedByRunPush(legs, { ids: ["run-4"], kind: "updated" })).toBe(true);
  });

  it("is true when a push names a live run of a leg that is not its newest", () => {
    expect(isAnyLegAffectedByRunPush(legs, { ids: ["x", "run-0"], kind: "deleted" })).toBe(true);
  });

  it("is false when a push names only runs no leg holds", () => {
    expect(isAnyLegAffectedByRunPush(legs, { ids: ["cron-run"], kind: "updated" })).toBe(false);
  });

  it("is false when a handoff's own run is not the newest or live one", () => {
    expect(isAnyLegAffectedByRunPush(legs, { ids: ["run-3"], kind: "updated" })).toBe(false);
  });

  it("is false with no legs held and a named run", () => {
    expect(isAnyLegAffectedByRunPush([], { ids: ["run-1"], kind: "updated" })).toBe(false);
  });
});
