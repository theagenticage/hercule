import type { Signal, TrackingDetail, TrackingRun, TrackingTask } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import type { TrackingRow } from "./tracking";
import {
  describeTrackingOutputValue,
  describeTrackingStanding,
  describeTrackingTrip,
  findNextTrackingElapsedChange,
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

/** Builds a Needs you row that waits on a Request of the live run `run`, with an open signal beside it when `signalAlsoWaits`. */
const buildRequestRow = (run: TrackingRun, signalAlsoWaits = false): TrackingRow => ({
  task: buildTask(run, [run.id]),
  run,
  state: "needs-you",
  waitsOn: {
    kind: "request",
    signalAlsoWaits,
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
    const run = buildRun("running");
    const stopOnly = [{ kind: "stop-run", run, leavesRowStopped: true, suggested: false }];
    expect(listTrackingAnswers(buildRow(run))).toEqual(stopOnly);
    expect(listTrackingAnswers(buildRow(buildRun("pending", { id: "run-1" })))).toMatchObject([
      { kind: "stop-run", run: { id: "run-1" }, suggested: false },
    ]);
    expect(listTrackingAnswers(buildRequestRow(run))).toEqual(stopOnly);
  });

  describe("when the row's run failed and an older run is live", () => {
    const row = buildRow(buildRun("failed"));
    const older = buildRun("running", { id: "run-older", workflowName: "Review PR" });
    const failedWithLiveRun: TrackingRow = {
      ...row,
      task: { ...row.task, latestLiveRun: older, liveRunIds: ["run-older"] },
    };

    it("stops the Task's newest live run, not the row's run, and the row does not become Stopped", () => {
      expect(listTrackingAnswers(failedWithLiveRun)).toEqual([
        { kind: "stop-run", run: older, leavesRowStopped: false, suggested: false },
      ]);
    });
  });

  it("leaves the row Stopped only when the stopped run is the Task's newest and no other run is live", () => {
    const newest = buildRun("running", { id: "run-2" });
    const older = buildRun("running", { id: "run-1" });
    const task = (liveRunIds: ReadonlyArray<string>): TrackingTask => ({
      ...buildTask(newest, liveRunIds),
      latestLiveRun: newest,
    });
    const readLeavesRowStopped = (row: TrackingRow) => {
      const [answer] = listTrackingAnswers(row);
      return answer?.kind === "stop-run" ? answer.leavesRowStopped : undefined;
    };
    expect(
      readLeavesRowStopped({ task: task(["run-2"]), run: newest, state: "working", since: at(20) }),
    ).toBe(true);
    // Another run stays live, so the row stays Working.
    expect(
      readLeavesRowStopped({
        task: task(["run-2", "run-1"]),
        run: newest,
        state: "working",
        since: at(20),
      }),
    ).toBe(false);
    // The newest live run is older than the Task's newest run, whose state the row shows once it stops.
    const completed = buildRun("completed", { id: "run-3" });
    const overtaken: TrackingTask = {
      ...buildTask(completed, ["run-1"]),
      latestLiveRun: older,
    };
    expect(
      readLeavesRowStopped({ task: overtaken, run: older, state: "working", since: at(20) }),
    ).toBe(false);
    // A signal that waits keeps the row on Needs you.
    expect(
      readLeavesRowStopped({
        ...buildSignalRow(newest, ["run-2"]),
        task: task(["run-2"]),
      }),
    ).toBe(false);
    // A Request alone: stopping the run leaves the row Stopped. With an open signal beside it, the signal keeps the row on Needs you.
    expect(readLeavesRowStopped(buildRequestRow(newest))).toBe(true);
    expect(readLeavesRowStopped(buildRequestRow(newest, true))).toBe(false);
  });

  it("offers Try again, Mark done and Cancel in the order of the state, suggesting one on Finished and Failed rows only", () => {
    const listAnswerKinds = (row: TrackingRow) =>
      listTrackingAnswers(row).map(({ kind, suggested }) => (suggested ? `${kind}*` : kind));
    expect(listAnswerKinds(buildRow(buildRun("completed")))).toEqual([
      "mark-done*",
      "try-again",
      "cancel",
    ]);
    expect(listAnswerKinds(buildRow(buildRun("failed")))).toEqual([
      "try-again*",
      "mark-done",
      "cancel",
    ]);
    expect(listAnswerKinds(buildRow(buildRun("cancelled")))).toEqual([
      "try-again",
      "mark-done",
      "cancel",
    ]);
    expect(listAnswerKinds(buildSignalRow(buildRun("completed")))).toEqual([
      "try-again",
      "mark-done",
      "cancel",
    ]);
  });
});

describe("describeTrackingStanding", () => {
  const describe_ = (row: TrackingRow) => describeTrackingStanding(row, TIMEZONE, NOW);

  it("says when a Finished or Failed run ended and how long it took", () => {
    expect(describe_(buildRow(buildRun("completed")))).toBe("Finished at 09:29 after 8m");
    expect(describe_(buildRow(buildRun("failed")))).toBe("Failed at 09:29 after 8m");
  });

  it("reads a duration in whole minutes, seconds only under a minute, and hours with the minutes left", () => {
    const took = (startedAt: string, finishedAt: string) =>
      describe_(buildRow(buildRun("completed", { startedAt, finishedAt })));
    expect(took(at(0), at(64))).toBe("Finished at 10:04 after 1h 4m");
    expect(took(at(0), at(120))).toBe("Finished at 11:00 after 2h");
    expect(took(at(0), at(8.5))).toBe("Finished at 09:08 after 8m");
    expect(took(at(0), at(2 / 3))).toBe("Finished at 09:00 after 40s");
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

  it("counts a Working run in the same minutes and hours as a finished one", () => {
    const working = (startedAt: string) =>
      describe_(buildRow(buildRun("running", { startedAt }))).split(" · ")[1];
    expect(working(at(-19))).toBe("1h 4m so far");
    expect(working(at(-15))).toBe("1h so far");
    expect(working(at(44.5))).toBe("just now");
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

describe("findNextTrackingElapsedChange", () => {
  it("is the next whole minute since the start, in the first minute, under an hour and past it", () => {
    const next = (since: string, now: Date) =>
      findNextTrackingElapsedChange(since, now).toISOString();
    expect(next(START, new Date(at(0.5)))).toBe(at(1));
    expect(next(START, new Date(at(1)))).toBe(at(2));
    expect(next(START, new Date(at(64.5)))).toBe(at(65));
    expect(next(START, new Date(at(120)))).toBe(at(121));
  });

  it("changes a minute after a start that lies in the future", () => {
    expect(findNextTrackingElapsedChange(at(10), new Date(at(0))).toISOString()).toBe(at(11));
  });
});

describe("describeTrackingTrip", () => {
  const OUTPUT: TrackingDetail["output"] = { kind: "text", stepName: "Code", text: "Done." };
  const HANDOFF: TrackingDetail["firstHandoff"] = {
    signalId: "signal-1",
    runId: "run-0",
    at: at(19),
    workflowName: "Review PR",
  };
  const buildDetail = (
    runs: ReadonlyArray<TrackingDetail["runs"][number]>,
    overrides: Partial<TrackingDetail> = {},
  ): TrackingDetail => ({ firstHandoff: HANDOFF, runs, ...overrides });
  const trip = (row: TrackingRow, detail: TrackingDetail) =>
    describeTrackingTrip(row, detail, TIMEZONE, NOW);

  it("names when and to which workflow the Task was handed off, with no fallback to the row's run", () => {
    const run = buildRun("completed");
    expect(trip(buildRow(run), buildDetail([run])).askedSmall).toBe("09:19 · handed to Review PR");
    expect(
      describeTrackingTrip(buildRow(run), buildDetail([run]), "Not/AZone", NOW).askedSmall,
    ).toBe("handed to Review PR");
  });

  it("carries the stamp of the row", () => {
    const run = buildRun("failed");
    expect(trip(buildRow(run), buildDetail([run])).stamp).toBe("failed 09:29");
  });

  it("gives the failure reason on a Failed row only", () => {
    const failed = buildRun("failed", { failureCause: "permission denied on ops-db" });
    expect(trip(buildRow(failed), buildDetail([failed])).failureCause).toBe(
      "permission denied on ops-db",
    );
    const stopped = buildRun("cancelled", { failureCause: "left over" });
    expect(trip(buildRow(stopped), buildDetail([stopped])).failureCause).toBeUndefined();
    expect(trip(buildRow(buildRun("failed")), buildDetail([])).failureCause).toBeUndefined();
  });

  it("gives the output and the ending action step on every state but Working", () => {
    const detail = (run: TrackingRun) =>
      buildDetail([run], { output: OUTPUT, endingActionStepName: "Post the review" });
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const run = buildRun(status);
      const drawn = trip(buildRow(run), detail(run));
      expect(drawn.output).toBe(OUTPUT);
      expect(drawn.endingActionStepName).toBe("Post the review");
    }
    const completed = buildRun("completed");
    const waiting = trip(buildSignalRow(completed), detail(completed));
    expect(waiting.output).toBe(OUTPUT);
    expect(waiting.endingActionStepName).toBe("Post the review");
  });

  it("gives the output of the last completed step, and no ending action step, on a Needs you row whose Request waits in a live newest run", () => {
    const live = buildRun("running");
    const drawn = trip(buildRequestRow(live), buildDetail([live], { output: OUTPUT }));
    expect(drawn.output).toBe(OUTPUT);
    expect(drawn.endingActionStepName).toBeUndefined();
  });

  it("leaves the output and the ending action step out of a Working row, even when the newest run ended", () => {
    const live = buildRun("running", { id: "run-live" });
    const newest = buildRun("completed", { id: "run-newest" });
    const row: TrackingRow = {
      task: { ...buildTask(newest, ["run-live"]), latestLiveRun: live },
      run: live,
      state: "working",
      since: live.createdAt,
    };
    const drawn = trip(
      row,
      buildDetail([live, newest], { output: OUTPUT, endingActionStepName: "Post the review" }),
    );
    expect(drawn.output).toBeUndefined();
    expect(drawn.endingActionStepName).toBeUndefined();
  });

  it("leaves the output and the ending action step out of a row whose run is not the newest, such as a Request of an older live run", () => {
    const older = buildRun("running", { id: "run-older" });
    const newest = buildRun("completed", { id: "run-newest" });
    const row: TrackingRow = {
      ...buildRequestRow(older),
      task: { ...buildTask(newest, ["run-older"]), latestLiveRun: older },
    };
    const drawn = trip(
      row,
      buildDetail([older, newest], { output: OUTPUT, endingActionStepName: "Post the review" }),
    );
    expect(drawn.output).toBeUndefined();
    expect(drawn.endingActionStepName).toBeUndefined();
  });

  /** Returns the trip's list entry for `run`, listed after an earlier run so the list is drawn. */
  const listRun = (run: TrackingRun) =>
    trip(buildRow(run), buildDetail([buildRun("completed", { id: "run-0" }), run])).runs.at(-1)!;

  it("names how a run that ended ended, and marks it", () => {
    expect(listRun(buildRun("completed"))).toMatchObject({ pose: "done", text: "finished" });
    expect(listRun(buildRun("cancelled"))).toMatchObject({ pose: "idle", text: "stopped" });
  });

  it("gives the reason a run failed, when it carries one", () => {
    expect(listRun(buildRun("failed"))).toMatchObject({ pose: "failed", text: "failed" });
    expect(
      listRun(buildRun("failed", { failureCause: "permission denied on ops-db" })),
    ).toMatchObject({ pose: "failed", text: "failed: permission denied on ops-db" });
  });

  it("says a live run is working, or names the signals it only waits on", () => {
    expect(listRun(buildRun("running"))).toMatchObject({ pose: "working", text: "working" });
    expect(listRun(buildRun("pending"))).toMatchObject({ pose: "working", text: "working" });
    expect(
      listRun(buildRun("running", { awaitedSignalIds: ["checks_passed", "merged"] })),
    ).toMatchObject({ pose: "working", text: "waiting for checks_passed, merged" });
  });

  describe("the stamp", () => {
    const stamp = (row: TrackingRow) => trip(row, buildDetail([row.run])).stamp;

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
      const run = buildRun("completed");
      expect(describeTrackingTrip(buildRow(run), buildDetail([run]), "Not/AZone", NOW).stamp).toBe(
        "finished",
      );
    });
  });

  it("leaves the output and the ending action step out when the read still lists an older newest run than the row's", () => {
    const older = buildRun("completed", { id: "run-older" });
    const newer = buildRun("failed", { id: "run-newer" });
    const stale = buildDetail([older], { output: OUTPUT, endingActionStepName: "Post the review" });

    const drawn = trip(buildRow(newer), stale);

    expect(drawn.output).toBeUndefined();
    expect(drawn.endingActionStepName).toBeUndefined();
    // Once the read lists the newer run too, it shows what the read holds for it.
    const fresh = buildDetail([older, newer], {
      output: OUTPUT,
      endingActionStepName: "Post the review",
    });
    expect(trip(buildRow(newer), fresh).output).toBe(OUTPUT);
    expect(trip(buildRow(newer), fresh).endingActionStepName).toBe("Post the review");
  });

  it("leaves the output out when the read lists no runs", () => {
    const run = buildRun("completed");
    expect(trip(buildRow(run), buildDetail([], { output: OUTPUT })).output).toBeUndefined();
  });

  it("opens the newest run's page for the whole output, and the row's run when the read lists none", () => {
    const first = buildRun("failed", { id: "run-1" });
    const second = buildRun("completed", { id: "run-2" });
    expect(trip(buildRow(second), buildDetail([first, second])).outputRunId).toBe("run-2");
    expect(trip(buildRow(second), buildDetail([])).outputRunId).toBe("run-2");
  });

  it("lists no runs for a single run that has ended, and each run of a longer history", () => {
    const only = buildRun("completed");
    expect(trip(buildRow(only), buildDetail([only])).runs).toEqual([]);
    const first = {
      ...buildRun("failed", {
        id: "run-1",
        failureCause: "step failed",
        workflowId: "workflow-1",
      }),
      sessionId: "session-1",
    };
    const second = buildRun("running", { id: "run-2", startedAt: at(40) });
    expect(trip(buildRow(second), buildDetail([first, second])).runs).toEqual([
      {
        runId: "run-1",
        time: "09:29",
        timeAt: at(29),
        pose: "failed",
        live: false,
        workflowName: "Implement",
        faceSeed: "workflow-1",
        text: "failed: step failed",
        sessionId: "session-1",
      },
      {
        runId: "run-2",
        time: "09:40",
        timeAt: at(40),
        pose: "working",
        live: true,
        workflowName: "Implement",
        faceSeed: "Implement",
        text: "working",
        sessionId: undefined,
      },
    ]);
  });

  it("lists a single run that is live, led by when it started", () => {
    const live = buildRun("running");
    expect(trip(buildRow(live), buildDetail([live])).runs).toHaveLength(1);
  });
});

describe("describeTrackingOutputValue", () => {
  it("returns a string or a number as it is, not muted", () => {
    expect(describeTrackingOutputValue("Ship it")).toEqual({ text: "Ship it", muted: false });
    expect(describeTrackingOutputValue("")).toEqual({ text: "", muted: false });
    expect(describeTrackingOutputValue(3)).toEqual({ text: "3", muted: false });
    expect(describeTrackingOutputValue(0)).toEqual({ text: "0", muted: false });
    expect(describeTrackingOutputValue(0.5)).toEqual({ text: "0.5", muted: false });
  });

  it("returns a boolean as yes or no, not muted", () => {
    expect(describeTrackingOutputValue(true)).toEqual({ text: "yes", muted: false });
    expect(describeTrackingOutputValue(false)).toEqual({ text: "no", muted: false });
  });

  it("returns null as none, muted", () => {
    expect(describeTrackingOutputValue(null)).toEqual({ text: "none", muted: true });
  });

  it("returns a count of items, singular for one, muted", () => {
    expect(describeTrackingOutputValue({ items: 1 })).toEqual({ text: "1 item", muted: true });
    expect(describeTrackingOutputValue({ items: 0 })).toEqual({ text: "0 items", muted: true });
    expect(describeTrackingOutputValue({ items: 4 })).toEqual({ text: "4 items", muted: true });
  });

  it("returns a count of fields, singular for one, muted", () => {
    expect(describeTrackingOutputValue({ fields: 1 })).toEqual({ text: "1 field", muted: true });
    expect(describeTrackingOutputValue({ fields: 2 })).toEqual({ text: "2 fields", muted: true });
  });
});
