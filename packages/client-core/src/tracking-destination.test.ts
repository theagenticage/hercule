import type { Signal, Task, TrackingRun, TrackingTask } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildTrackingRows, type TrackingWaits } from "./tracking";
import { decideTrackingRowDestination } from "./tracking-destination";

const AT = "2026-10-20T09:00:00.000Z";

const buildRun = (status: TrackingRun["status"]): TrackingRun => ({
  id: "run-1",
  workflowId: null,
  workflowName: "Implement",
  status,
  createdAt: AT,
  awaitedSignalIds: [],
});

const task: TrackingTask = {
  taskId: "task-1",
  title: "Upgrade the Stripe SDK",
  handoffs: [{ signalId: "signal-0", runId: "run-1", at: AT }],
  latestRun: buildRun("running"),
  latestLiveRun: buildRun("running"),
};

const signal: Signal = {
  id: "signal-checks",
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

const yourWorkTask: Task = {
  id: "task-1",
  title: "Upgrade the Stripe SDK",
  description: "",
  status: "in-progress",
  priority: "normal",
  labels: [],
  provenance: [],
  createdAt: AT,
  updatedAt: AT,
  statusChangedAt: AT,
};

const decide = (waits: Partial<TrackingWaits>) =>
  decideTrackingRowDestination(
    buildTrackingRows([task], { requests: [], signals: [], yourWork: new Map(), ...waits })[0]!,
  );

describe("decideTrackingRowDestination", () => {
  it("opens the run's page for a row that waits on nothing", () => {
    expect(decide({})).toEqual({ kind: "run", runId: "run-1" });
  });

  it("opens the thread of the session whose Request waits", () => {
    const request = {
      sessionId: "session-1",
      runId: "run-1",
      stepId: "implement",
      title: "Implement · implement",
      question: "Run git push?",
      activityAt: AT,
    };
    expect(decide({ requests: [request] })).toEqual({ kind: "thread", sessionId: "session-1" });
  });

  it("opens the signal that names the Task as Your work", () => {
    expect(
      decide({
        signals: [signal],
        yourWork: new Map([[signal.id, [yourWorkTask]]]),
      }),
    ).toEqual({ kind: "signal", signalId: "signal-checks" });
  });
});
