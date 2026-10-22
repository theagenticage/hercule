import type { HandoffLeg, Signal, TrackingRun } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  describeHandoffTrip,
  isAnyLegAffectedByRunPush,
  isAnyLegAffectedByTaskPush,
} from "./handoff-leg";
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

/** Builds the newest run of a leg, which carries only its id and status. */
const buildLegRun = (id: string, status: RunStatus): HandoffLeg["latestRun"] => ({ id, status });

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
  latestRun: buildLegRun("run-1", "completed"),
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
 * `handoffRunId`. Its newest run is `latestRunId`. The row is in the state of that run, or Needs you
 * when `needsYou` is set, as a live run with an open Request makes it.
 */
const buildRow = (
  status: RunStatus,
  {
    handoffRunId = "run-1",
    latestRunId = "run-1",
    needsYou = false,
    signalWaits = false,
    liveRunIds = undefined,
  }: {
    handoffRunId?: string;
    latestRunId?: string;
    needsYou?: boolean;
    signalWaits?: boolean;
    /** The ids of the Task's live runs, by default the newest run when it is live. */
    liveRunIds?: ReadonlyArray<string>;
  } = {},
): TrackingRow => {
  const run = buildRun(latestRunId, status);
  const live = status === "pending" || status === "running";
  const [row] = buildTrackingRows(
    [
      {
        taskId: "task",
        title: "Task",
        handoffs: [{ signalId: "sig", runId: handoffRunId, at: AT }],
        latestRun: run,
        ...(live ? { latestLiveRun: run } : {}),
        liveRunIds: liveRunIds ?? (live ? [run.id] : []),
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
        latestRun: buildLegRun("run-1", "running"),
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
        latestRun: buildLegRun("run-1", "running"),
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
        latestRun: buildLegRun("run-1", "failed"),
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
      const leg = buildLeg({ latestRun: buildLegRun("run-1", "cancelled") });
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
        latestRun: buildLegRun("run-2", "completed"),
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
        destination: { kind: "tracking", taskId: "task" },
      });
    });
  });

  describe("edge cases", () => {
    it("says a live earlier leg is still working", () => {
      const leg = buildLeg({
        latestRun: buildLegRun("run-1", "running"),
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
      const leg = buildLeg({ latestRun: buildLegRun("run-1", "failed") });
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
      expect(trip?.destination).toEqual({ kind: "tracking", taskId: "task" });
    });

    it.each([
      ["the row's newest run is another run", buildRow("completed", { latestRunId: "run-2" })],
      ["the row's newest run is in another status", buildRow("running")],
    ])("ends on the leg's standing when %s", (_name, row) => {
      const trip = describeHandoffTrip(buildSignal(), buildLeg(), row);
      expect(trip).toMatchObject({
        steps: ["Handed to Implement"],
        end: { text: "finished", tone: null },
        pose: "done",
      });
    });

    it("does not call a re-run finished when the Done read is newer than the Tracking read", () => {
      // Tracking was read while the re-run ran; Done after it finished.
      const leg = buildLeg({ rerunCount: 1, latestRun: buildLegRun("run-2", "completed") });
      const trip = describeHandoffTrip(
        buildSignal(),
        leg,
        buildRow("running", { latestRunId: "run-2" }),
      );
      expect(trip).toMatchObject({
        steps: ["Handed to Implement", "tried again once"],
        end: { text: "finished", tone: null },
        pose: "done",
        destination: { kind: "tracking", taskId: "task" },
      });
    });

    it("does not call a re-run running when the Tracking read is newer than the Done read", () => {
      // Done was read while the re-run ran; Tracking after it finished.
      const leg = buildLeg({
        rerunCount: 1,
        latestRun: buildLegRun("run-2", "running"),
        liveRunIds: ["run-2"],
      });
      const trip = describeHandoffTrip(
        buildSignal(),
        leg,
        buildRow("completed", { latestRunId: "run-2" }),
      );
      expect(trip).toMatchObject({
        steps: ["Handed to Implement", "tried again once"],
        end: { text: "working", tone: null },
        pose: "working",
        destination: { kind: "tracking", taskId: "task" },
      });
    });

    it("trusts a row that agrees with a re-run leg", () => {
      const leg = buildLeg({ rerunCount: 1, latestRun: buildLegRun("run-2", "completed") });
      const trip = describeHandoffTrip(
        buildSignal(),
        leg,
        buildRow("completed", { latestRunId: "run-2" }),
      );
      expect(trip?.end).toEqual({ text: "finished", tone: "finished" });
    });

    it("does not call a handoff finished when its older sibling re-run ended between the reads", () => {
      // Runs B (older) and C (newer) re-ran the handoff. Tracking was read while B
      // ran and C was done; Done after B ended, so every run has ended.
      const leg = buildLeg({ rerunCount: 2, latestRun: buildLegRun("run-c", "completed") });
      const row = buildRow("completed", { latestRunId: "run-c", liveRunIds: ["run-b"] });
      const trip = describeHandoffTrip(buildSignal(), leg, row);
      expect(trip).toMatchObject({
        steps: ["Handed to Implement", "tried again twice"],
        end: { text: "finished", tone: null },
        pose: "done",
      });
    });

    it("trusts a row that holds the same live runs as the leg, in any order", () => {
      const leg = buildLeg({
        rerunCount: 1,
        latestRun: buildLegRun("run-1", "running"),
        liveRunIds: ["run-1", "run-b"],
      });
      const row = buildRow("running", { needsYou: true, liveRunIds: ["run-b", "run-1"] });
      const trip = describeHandoffTrip(buildSignal(), leg, row);
      expect(trip?.end).toEqual({ text: "needs you", tone: "waits" });
    });

    it("ends on the leg's standing when the row holds a live run the leg does not", () => {
      // The live run belongs to another leg of the Task.
      const row = buildRow("completed", { liveRunIds: ["run-other"] });
      const trip = describeHandoffTrip(buildSignal(), buildLeg(), row);
      expect(trip).toMatchObject({
        steps: ["Handed to Implement"],
        end: { text: "finished", tone: null },
        pose: "done",
      });
    });

    it("opens Tracking for an earlier leg while its Task is in progress, keeping its own end", () => {
      const leg = buildLeg({
        next: { signalId: "sig-2", runId: "run-9", at: AT, workflowName: "Fix bug" },
      });
      const trip = describeHandoffTrip(
        buildSignal(),
        leg,
        buildRow("running", { latestRunId: "run-9" }),
      );
      expect(trip?.destination).toEqual({ kind: "tracking", taskId: "task" });
      expect(trip?.end.text).toBe("continued: Fix bug");
    });

    it("opens Tracking for a leg whose row it disagrees with, but not for a done Task", () => {
      const row = buildRow("running", { handoffRunId: "run-9" });
      expect(describeHandoffTrip(buildSignal(), buildLeg(), row)?.destination).toEqual({
        kind: "tracking",
        taskId: "task",
      });
      expect(
        describeHandoffTrip(buildSignal(), buildLeg({ taskStatus: "done" }), row)?.destination,
      ).toEqual({ kind: "run", runId: "run-1" });
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
        latestRun: buildLegRun("run-1", "running"),
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
      const leg = buildLeg({ latestRun: buildLegRun("run-1", "cancelled") });
      expect(describeHandoffTrip(buildSignal(), leg, undefined)?.pose).toBe("idle");
    });

    it("treats a failed newest run as failed even while an older run of the leg is live", () => {
      const leg = buildLeg({ latestRun: buildLegRun("run-2", "failed"), liveRunIds: ["run-1"] });
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
    buildLeg({ latestRun: buildLegRun("run-1", "running"), liveRunIds: ["run-1", "run-0"] }),
    buildLeg({ runId: "run-3", latestRun: buildLegRun("run-4", "completed") }),
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

describe("isAnyLegAffectedByTaskPush", () => {
  const legs = [buildLeg({ taskId: "task-a" }), buildLeg({ taskId: "task-b" })];

  it("is true when the push lists no ids", () => {
    expect(isAnyLegAffectedByTaskPush(legs, { ids: [] })).toBe(true);
  });

  it("is true when a push names the Task of a leg", () => {
    expect(isAnyLegAffectedByTaskPush(legs, { ids: ["x", "task-b"] })).toBe(true);
  });

  it("is false when a push names only Tasks no leg names", () => {
    expect(isAnyLegAffectedByTaskPush(legs, { ids: ["task-c"] })).toBe(false);
  });

  it("is false with no legs held and a named Task", () => {
    expect(isAnyLegAffectedByTaskPush([], { ids: ["task-a"] })).toBe(false);
  });
});
