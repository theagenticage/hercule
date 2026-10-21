import type { Signal, TrackingRun, TrackingTask } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import type { TrackingRow } from "./tracking";
import {
  describeTrackingRunLine,
  describeTrackingStamp,
  describeTrackingStanding,
  listTrackingAnswers,
} from "./tracking-pane";

const START = "2026-10-20T09:00:00.000Z";
const at = (minutes: number): string =>
  new Date(Date.parse(START) + minutes * 60_000).toISOString();
const NOW = new Date(at(45));
const TIMEZONE = "UTC";

/** Builds a run created at minute `createdAt` that started a minute later and, once ended, ran 8 minutes. */
const buildRun = (
  status: TrackingRun["status"],
  overrides: Partial<TrackingRun> = {},
): TrackingRun => ({
  id: "run-1",
  workflowId: null,
  workflowName: "Implement",
  status,
  createdAt: at(20),
  ...(status === "pending" ? {} : { startedAt: at(21) }),
  ...(status === "completed" || status === "failed" || status === "cancelled"
    ? { finishedAt: at(29) }
    : {}),
  awaitedSignalIds: [],
  ...overrides,
});

const buildTask = (run: TrackingRun, liveRunIds: ReadonlyArray<string>): TrackingTask => ({
  taskId: "task-1",
  title: "Task 1",
  handoffs: [{ signalId: "signal-1", runId: run.id, at: at(19) }],
  latestRun: run,
  liveRunIds,
});

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
  createdAt: at(33),
};

/** Builds the row of a Task whose newest run is `run`, in the state the run puts it in. */
const buildRow = (run: TrackingRun): TrackingRow => {
  const live = run.status === "pending" || run.status === "running";
  const task = buildTask(run, live ? [run.id] : []);
  switch (run.status) {
    case "completed":
      return { task, run, state: "finished", since: at(29) };
    case "failed":
      return { task, run, state: "failed", since: at(29) };
    case "cancelled":
      return { task, run, state: "stopped", since: at(29) };
    case "pending":
    case "running":
      return { task, run, state: "working", since: run.createdAt };
  }
};

/** Builds a Needs you row that waits on a Request of the live run `run`. */
const buildRequestRow = (run: TrackingRun): TrackingRow => ({
  task: buildTask(run, [run.id]),
  run,
  state: "needs-you",
  waitsOn: {
    kind: "request",
    session: {
      sessionId: "session-1",
      runId: run.id,
      stepId: "implement",
      title: "Implement",
      question: "Run git push?",
      activityAt: at(33),
    },
  },
  since: at(33),
});

/** Builds a Needs you row that waits on a signal, with `run` as its newest run. */
const buildSignalRow = (run: TrackingRun, liveRunIds: ReadonlyArray<string> = []): TrackingRow => ({
  task: buildTask(run, liveRunIds),
  run,
  state: "needs-you",
  waitsOn: { kind: "signal", signal: SIGNAL },
  since: at(33),
});

describe("listTrackingAnswers", () => {
  it("offers only Stop the run, never suggested, while a run is going", () => {
    const stopOnly = [{ kind: "stop-run", suggested: false }];
    expect(listTrackingAnswers(buildRow(buildRun("running")))).toEqual(stopOnly);
    expect(listTrackingAnswers(buildRow(buildRun("pending")))).toEqual(stopOnly);
    expect(listTrackingAnswers(buildRequestRow(buildRun("running")))).toEqual(stopOnly);
  });

  it("offers Stop the run on a row whose newest run ended but an older run is live", () => {
    const row = buildSignalRow(buildRun("failed"), ["run-older"]);
    expect(listTrackingAnswers(row)).toEqual([{ kind: "stop-run", suggested: false }]);
  });

  it("suggests Mark done on a Finished row, then Cancel", () => {
    expect(listTrackingAnswers(buildRow(buildRun("completed")))).toEqual([
      { kind: "mark-done", suggested: true },
      { kind: "cancel", suggested: false },
    ]);
  });

  it("suggests nothing on a Failed, Stopped or waiting-on-a-signal row, which can still be marked done or cancelled", () => {
    const unsuggested = [
      { kind: "mark-done", suggested: false },
      { kind: "cancel", suggested: false },
    ];
    expect(listTrackingAnswers(buildRow(buildRun("failed")))).toEqual(unsuggested);
    expect(listTrackingAnswers(buildRow(buildRun("cancelled")))).toEqual(unsuggested);
    expect(listTrackingAnswers(buildSignalRow(buildRun("completed")))).toEqual(unsuggested);
  });
});

describe("describeTrackingStanding", () => {
  const describe_ = (row: TrackingRow) => describeTrackingStanding(row, TIMEZONE, NOW);

  it("says when a Finished or Failed run ended and how long it took", () => {
    expect(describe_(buildRow(buildRun("completed")))).toBe("Finished at 09:29 after 8m 0s");
    expect(describe_(buildRow(buildRun("failed")))).toBe("Failed at 09:29 after 8m 0s");
  });

  it("drops the seconds from a duration of an hour or more", () => {
    const long = buildRun("completed", { startedAt: at(0), finishedAt: at(64) });
    expect(describe_(buildRow(long))).toBe("Finished at 10:04 after 1h 4m");
  });

  it("leaves the duration out of a run that never started", () => {
    // A pending run has no `startedAt`; it fails at once.
    const neverStarted = buildRun("pending", { status: "failed", finishedAt: at(29) });
    expect(describe_(buildRow(neverStarted))).toBe("Failed at 09:29");
  });

  it("says when a Stopped run ended, and never who stopped it", () => {
    expect(describe_(buildRow(buildRun("cancelled")))).toBe("Stopped at 09:29");
  });

  it("says when a Working run started and how long ago", () => {
    expect(describe_(buildRow(buildRun("running")))).toBe("Started at 09:21 · 24m so far");
    expect(describe_(buildRow(buildRun("running", { startedAt: at(44.5) })))).toBe(
      "Started at 09:44 · just now",
    );
  });

  it("dates a Pending run from its creation", () => {
    expect(describe_(buildRow(buildRun("pending")))).toBe("Started at 09:20 · 25m so far");
  });

  it("says since when a Needs you row waits on the user, by a Request or by a signal", () => {
    expect(describe_(buildRequestRow(buildRun("running")))).toBe("Waiting on you since 09:33");
    expect(describe_(buildSignalRow(buildRun("completed")))).toBe("Waiting on you since 09:33");
  });

  it("shows the day of a time that is not today", () => {
    const old = new Date(at(3 * 24 * 60));
    expect(describeTrackingStanding(buildRow(buildRun("cancelled")), TIMEZONE, old)).toBe(
      "Stopped at 20 Oct 09:29",
    );
  });

  it("leaves the time out when the time zone is not valid", () => {
    expect(describeTrackingStanding(buildRow(buildRun("cancelled")), "Not/AZone", NOW)).toBe(
      "Stopped",
    );
    expect(describeTrackingStanding(buildSignalRow(buildRun("completed")), "Not/AZone", NOW)).toBe(
      "Waiting on you",
    );
  });
});

describe("describeTrackingRunLine", () => {
  it("names how a run that ended ended", () => {
    expect(describeTrackingRunLine(buildRun("completed"))).toBe("finished");
    expect(describeTrackingRunLine(buildRun("cancelled"))).toBe("stopped");
  });

  it("gives the reason a run failed, when it carries one", () => {
    expect(describeTrackingRunLine(buildRun("failed"))).toBe("failed");
    expect(
      describeTrackingRunLine(buildRun("failed", { failureCause: "permission denied on ops-db" })),
    ).toBe("failed: permission denied on ops-db");
  });

  it("says a live run is working, or names the signals it only waits on", () => {
    expect(describeTrackingRunLine(buildRun("running"))).toBe("working");
    expect(describeTrackingRunLine(buildRun("pending"))).toBe("working");
    expect(
      describeTrackingRunLine(
        buildRun("running", { awaitedSignalIds: ["checks_passed", "merged"] }),
      ),
    ).toBe("waiting for checks_passed, merged");
  });
});

describe("describeTrackingStamp", () => {
  const stamp = (row: TrackingRow) => describeTrackingStamp(row, TIMEZONE, NOW);

  it("stamps the time the run ended", () => {
    expect(stamp(buildRow(buildRun("completed")))).toBe("finished 09:29");
    expect(stamp(buildRow(buildRun("failed")))).toBe("failed 09:29");
    expect(stamp(buildRow(buildRun("cancelled")))).toBe("stopped 09:29");
  });

  it("says a live run is working", () => {
    expect(stamp(buildRow(buildRun("running")))).toBe("working");
  });

  it("stamps a Request's wait with when the session was last active", () => {
    expect(stamp(buildRequestRow(buildRun("running")))).toBe("waiting on you since 09:33");
  });

  it("stamps a row that waits on a signal with its last run, not with the wait", () => {
    expect(stamp(buildSignalRow(buildRun("completed")))).toBe("finished 09:29");
    expect(stamp(buildSignalRow(buildRun("failed")))).toBe("failed 09:29");
    expect(stamp(buildSignalRow(buildRun("running"), ["run-1"]))).toBe("working");
  });

  it("is the word alone when the time cannot be formatted", () => {
    expect(describeTrackingStamp(buildRow(buildRun("completed")), "Not/AZone", NOW)).toBe(
      "finished",
    );
  });
});
