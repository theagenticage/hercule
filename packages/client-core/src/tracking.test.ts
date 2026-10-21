import type { Signal, TrackingRun, TrackingTask } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  buildTrackingRows,
  canMarkTrackingStateDone,
  countWaitingTrackingRows,
  decideTrackingRowDestination,
  describeTrackingLine,
  groupTrackingRows,
  isTrackingAffectedByRunPush,
  listRecentTrackingRows,
  type TrackingState,
} from "./tracking";
import { isRunLive } from "./run-display";
import type { WaitingRunSession } from "./waiting";
import type { YourWork } from "./your-work";

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

/**
 * Builds a tracked Task handed off at minute `handedOffAt`, with its newest
 * run, its newest live run and the ids of its live runs. By default those are
 * the newest run when it is live, then the newest live run.
 */
const buildTask = (
  taskId: string,
  latestRun: TrackingRun,
  {
    handedOffAt = 0,
    latestLiveRun,
    liveRunIds = [
      ...new Set(
        [latestRun, latestLiveRun].flatMap((run) =>
          run !== undefined && isRunLive(run.status) ? [run.id] : [],
        ),
      ),
    ],
  }: {
    handedOffAt?: number;
    latestLiveRun?: TrackingRun;
    liveRunIds?: ReadonlyArray<string>;
  } = {},
): TrackingTask => ({
  taskId,
  title: `Task ${taskId}`,
  handoffs: [{ signalId: `signal-${taskId}`, runId: latestRun.id, at: at(handedOffAt) }],
  latestRun,
  ...(latestLiveRun === undefined ? {} : { latestLiveRun }),
  liveRunIds,
});

const NO_YOUR_WORK: YourWork = new Map();

/** Builds the session of run `runId` that waits on the question `question`, last active at minute `activityAt`. */
const buildWaitingSession = (
  sessionId: string,
  runId: string,
  activityAt: number,
  question = "Run git push?",
): WaitingRunSession => ({
  sessionId,
  runId,
  stepId: "implement",
  title: `Implement · implement`,
  question,
  activityAt: at(activityAt),
});

/** Builds an open signal raised at minute `createdAt`, about `place`, or about no place for `null`. */
const buildSignal = (
  id: string,
  createdAt: number,
  place: string | null = "payments-api #1302",
): Signal => ({
  id,
  kind: "github/checks-failed",
  origin: { type: "api", actor: "user", eventIds: [], reason: "Test" },
  title: `Signal ${id}`,
  ...(place === null ? {} : { place }),
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: at(createdAt),
});

/** Builds Your work for `signals`: each signal is about the Tasks whose ids are listed for it. */
const buildYourWork = (about: ReadonlyArray<readonly [Signal, ReadonlyArray<string>]>): YourWork =>
  new Map(
    about.map(([signal, taskIds]) => [
      signal.id,
      {
        signal,
        tasks: taskIds.map((id) => ({
          id,
          title: `Task ${id}`,
          status: "in-progress" as const,
          updatedAt: at(0),
          provenanceRefs: [],
        })),
      },
    ]),
  );

const stateOf = (task: TrackingTask): TrackingState | undefined =>
  buildTrackingRows([task], [], NO_YOUR_WORK)[0]?.state;

describe("buildTrackingRows", () => {
  it("puts a Task whose newest run failed in Failed, even when an older run is live", () => {
    const task = buildTask("a", buildRun("r2", 5, "failed"), {
      latestLiveRun: buildRun("r1", 0, "running"),
    });
    expect(stateOf(task)).toBe("failed");
    expect(buildTrackingRows([task], [], NO_YOUR_WORK)[0]?.run.id).toBe("r2");
  });

  it("puts a Task with a live run in Working, pending or running", () => {
    expect(stateOf(buildTask("a", buildRun("r1", 0, "pending")))).toBe("working");
    expect(stateOf(buildTask("a", buildRun("r1", 0, "running")))).toBe("working");
  });

  it("keeps a Task working while an older run is live and the newest run completed, and reads the live run", () => {
    const live = buildRun("r1", 0, "running");
    const [row] = buildTrackingRows(
      [buildTask("a", buildRun("r2", 5, "completed"), { latestLiveRun: live })],
      [],
      NO_YOUR_WORK,
    );
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
    const since = (run: TrackingRun) =>
      buildTrackingRows([buildTask("a", run)], [], NO_YOUR_WORK)[0]?.since;
    expect(since(buildRun("r", 0, "failed"))).toBe(at(10));
    expect(since(buildRun("r", 0, "completed"))).toBe(at(10));
    expect(since(buildRun("r", 0, "cancelled"))).toBe(at(10));
    // A live run's row is as old as the run, so pending to running keeps its age.
    expect(since(buildRun("r", 0, "running"))).toBe(at(0));
    expect(since(buildRun("r", 0, "pending"))).toBe(at(0));
  });

  it("orders Failed, Finished, Working, Stopped", () => {
    const rows = buildTrackingRows(
      [
        buildTask("stopped", buildRun("r1", 0, "cancelled")),
        buildTask("working", buildRun("r2", 0, "running")),
        buildTask("finished", buildRun("r3", 0, "completed")),
        buildTask("failed", buildRun("r4", 0, "failed")),
      ],
      [],
      NO_YOUR_WORK,
    );
    expect(rows.map((row) => row.task.taskId)).toEqual([
      "failed",
      "finished",
      "working",
      "stopped",
    ]);
  });

  it("orders a state's rows by the oldest handoff first, reading the Task's newest handoff", () => {
    // Handed off at minute 5, then again at minute 40: the newest handoff counts, and it comes first.
    const again: TrackingTask = {
      ...buildTask("again", buildRun("r3", 0, "completed"), { handedOffAt: 5 }),
      handoffs: [
        { signalId: "s2", runId: "r3", at: at(40) },
        { signalId: "s1", runId: "r0", at: at(5) },
      ],
    };
    const rows = buildTrackingRows(
      [
        again,
        buildTask("middle", buildRun("r2", 0, "completed"), { handedOffAt: 30 }),
        buildTask("old", buildRun("r1", 0, "completed"), { handedOffAt: 20 }),
      ],
      [],
      NO_YOUR_WORK,
    );
    expect(rows.map((row) => row.task.taskId)).toEqual(["old", "middle", "again"]);
  });
});

describe("a Task that needs you", () => {
  const working = buildTask("a", buildRun("r1", 0, "running"));

  it("turns Needs you while a session of its live run has a Request, and back to Working once it is answered", () => {
    const request = buildWaitingSession("s1", "r1", 7);
    const [asked] = buildTrackingRows([working], [request], NO_YOUR_WORK);
    expect(asked).toMatchObject({
      state: "needs-you",
      waitsOn: { kind: "request", session: request },
      since: at(7),
    });
    // The row still reads its run, so the run can be opened.
    expect(asked?.run.id).toBe("r1");
    expect(stateOf(working)).toBe("working");
  });

  it("finds a Request on the newest live run when an older run is the newest", () => {
    const task = buildTask("a", buildRun("r2", 5, "completed"), {
      latestLiveRun: buildRun("r1", 0, "running"),
    });
    const requests = [buildWaitingSession("s1", "r1", 7)];
    expect(buildTrackingRows([task], requests, NO_YOUR_WORK)[0]?.state).toBe("needs-you");
  });

  it("finds a Request on any live run of the Task, not only the newest", () => {
    // Two live runs; only the older one's session asks.
    const task = buildTask("a", buildRun("r2", 5, "running"), {
      latestLiveRun: buildRun("r2", 5, "running"),
      liveRunIds: ["r2", "r1"],
    });
    const requests = [buildWaitingSession("s1", "r1", 7)];
    expect(buildTrackingRows([task], requests, NO_YOUR_WORK)[0]).toMatchObject({
      state: "needs-you",
      waitsOn: { kind: "request", session: { sessionId: "s1" } },
    });
  });

  it("ignores the Request of a run that is not live or not the row's", () => {
    const finished = buildTask("a", buildRun("r1", 0, "completed"));
    const requests = [buildWaitingSession("s1", "r1", 7), buildWaitingSession("s2", "other", 7)];
    expect(buildTrackingRows([working, finished], requests, NO_YOUR_WORK)[1]?.state).toBe(
      "finished",
    );
    expect(
      buildTrackingRows([buildTask("b", buildRun("r9", 0, "running"))], requests, NO_YOUR_WORK)[0]
        ?.state,
    ).toBe("working");
  });

  it("turns Needs you while an open signal names the Task as Your work, whatever its runs did", () => {
    const signal = buildSignal("sig", 3);
    const yourWork = buildYourWork([[signal, ["a", "b", "c"]]]);
    const tasks = [
      buildTask("a", buildRun("r1", 0, "running")),
      buildTask("b", buildRun("r2", 0, "failed")),
      buildTask("c", buildRun("r3", 0, "completed")),
    ];
    const rows = buildTrackingRows(tasks, [], yourWork);
    expect(rows.map((row) => row.state)).toEqual(["needs-you", "needs-you", "needs-you"]);
    expect(rows[0]).toMatchObject({ waitsOn: { kind: "signal", signal }, since: at(3) });
  });

  it("leaves a Task alone when the signals are about other Tasks", () => {
    const yourWork = buildYourWork([[buildSignal("sig", 3), ["other"]]]);
    expect(buildTrackingRows([working], [], yourWork)[0]?.state).toBe("working");
  });

  it("puts a Request above a signal, and Needs you above Failed", () => {
    const failed = buildTask("a", buildRun("r2", 5, "failed"), {
      latestLiveRun: buildRun("r1", 0, "running"),
    });
    const request = buildWaitingSession("s1", "r1", 9);
    const yourWork = buildYourWork([[buildSignal("sig", 1), ["a"]]]);
    // The newest run failed, but the older live run asks, so the row waits on the Request.
    expect(buildTrackingRows([failed], [request], yourWork)[0]).toMatchObject({
      state: "needs-you",
      waitsOn: { kind: "request", session: request },
    });
    expect(buildTrackingRows([failed], [], yourWork)[0]?.state).toBe("needs-you");
  });

  it("picks the oldest Request, and the oldest signal, whatever order they come in", () => {
    const requests = [
      buildWaitingSession("s2", "r1", 8),
      buildWaitingSession("s1", "r1", 4),
      buildWaitingSession("s3", "r1", 6),
    ];
    const asked = buildTrackingRows([working], requests, NO_YOUR_WORK)[0];
    expect(asked).toMatchObject({ waitsOn: { session: { sessionId: "s1" } }, since: at(4) });

    const signals = [buildSignal("new", 9), buildSignal("old", 2), buildSignal("mid", 5)];
    const raised = buildTrackingRows(
      [working],
      [],
      buildYourWork(signals.map((signal) => [signal, ["a"]] as const)),
    )[0];
    expect(raised).toMatchObject({ waitsOn: { signal: { id: "old" } }, since: at(2) });
  });

  it("orders Needs you above every other state, the oldest handoff first inside it", () => {
    const tasks = [
      buildTask("failed", buildRun("r1", 0, "failed")),
      buildTask("late", buildRun("r2", 0, "running"), { handedOffAt: 20 }),
      buildTask("early", buildRun("r3", 0, "completed"), { handedOffAt: 10 }),
    ];
    const yourWork = buildYourWork([[buildSignal("sig", 1), ["late", "early"]]]);
    expect(buildTrackingRows(tasks, [], yourWork).map((row) => row.task.taskId)).toEqual([
      "early",
      "late",
      "failed",
    ]);
  });

  it("counts toward To do but cannot be marked done", () => {
    const rows = buildTrackingRows(
      [working, buildTask("b", buildRun("r2", 0, "running"))],
      [],
      buildYourWork([[buildSignal("sig", 1), ["a"]]]),
    );
    expect(countWaitingTrackingRows(rows)).toBe(1);
    expect(canMarkTrackingStateDone("needs-you")).toBe(false);
  });
});

describe("listRecentTrackingRows", () => {
  const buildRow = (id: string, minute: number) =>
    buildTrackingRows(
      [buildTask(id, buildRun(`r-${id}`, minute - 10, "completed"))],
      [],
      NO_YOUR_WORK,
    )[0]!;

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
    const rows = buildTrackingRows(
      [
        buildTask("a", buildRun("r1", 0, "failed")),
        buildTask("b", buildRun("r2", 0, "completed")),
        buildTask("c", buildRun("r3", 0, "running")),
        buildTask("d", buildRun("r4", 0, "cancelled")),
      ],
      [],
      NO_YOUR_WORK,
    );
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
  const tasks = [
    buildTask("a", buildRun("r2", 5, "completed"), { latestLiveRun: buildRun("r1", 0, "running") }),
  ];

  it("is affected by a push that names a Task's newest run or newest live run", () => {
    expect(isTrackingAffectedByRunPush(tasks, { ids: ["r1"], kind: "updated" })).toBe(true);
    expect(isTrackingAffectedByRunPush(tasks, { ids: ["x", "r2"], kind: "deleted" })).toBe(true);
  });

  it("is affected by a push that names an older live run, whose end changes which Requests the row waits on", () => {
    const withOlderLiveRun = [
      buildTask("a", buildRun("r3", 8, "running"), { liveRunIds: ["r3", "r-older"] }),
    ];
    expect(
      isTrackingAffectedByRunPush(withOlderLiveRun, { ids: ["r-older"], kind: "updated" }),
    ).toBe(true);
  });

  it("is affected by a push that lists no ids, and by the creation of a run, which may be a re-run", () => {
    expect(isTrackingAffectedByRunPush(tasks, { ids: [], kind: "updated" })).toBe(true);
    expect(isTrackingAffectedByRunPush(tasks, { ids: ["new"], kind: "created" })).toBe(true);
  });

  it("is not affected by a change to a run no Task holds", () => {
    expect(isTrackingAffectedByRunPush(tasks, { ids: ["x", "y"], kind: "updated" })).toBe(false);
    expect(isTrackingAffectedByRunPush([], { ids: ["x"], kind: "updated" })).toBe(false);
  });
});

describe("describeTrackingLine", () => {
  const rowOf = (run: TrackingRun) =>
    buildTrackingRows([buildTask("a", run)], [], NO_YOUR_WORK)[0]!;

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

  it("leads a Needs you line with what waits, with no workflow name: a Request's question", () => {
    const task = buildTask("a", buildRun("r", 0, "running"));
    const row = buildTrackingRows(
      [task],
      [buildWaitingSession("s", "r", 1, "Run git push?")],
      NO_YOUR_WORK,
    )[0]!;
    expect(describeTrackingLine(row)).toEqual({ workflowName: null, text: "Run git push?" });
  });

  it("leads a Needs you line with what waits: a signal's kind and place", () => {
    const task = buildTask("a", buildRun("r", 0, "completed"));
    const line = (signal: Signal) =>
      describeTrackingLine(buildTrackingRows([task], [], buildYourWork([[signal, ["a"]]]))[0]!);
    expect(line(buildSignal("sig", 1))).toEqual({
      workflowName: null,
      text: "Checks failed on payments-api #1302",
    });
    expect(line(buildSignal("sig", 1, null)).text).toBe("Checks failed");
  });

  it("says a cancelled run is stopped", () => {
    expect(describeTrackingLine(rowOf(buildRun("r", 0, "cancelled"))).text).toBe("· stopped");
  });
});

describe("groupTrackingRows", () => {
  it("groups the rows by state in Tracking's order, keeping the order inside a group", () => {
    const rows = buildTrackingRows(
      [
        buildTask("w1", buildRun("r1", 0, "running"), { handedOffAt: 1 }),
        buildTask("f1", buildRun("r2", 0, "failed")),
        buildTask("w2", buildRun("r3", 0, "running"), { handedOffAt: 2 }),
        buildTask("s1", buildRun("r4", 0, "cancelled")),
        buildTask("n1", buildRun("r5", 0, "running")),
      ],
      [],
      buildYourWork([[buildSignal("sig", 1), ["n1"]]]),
    );
    expect(
      groupTrackingRows(rows).map(({ state, rows: inState }) => [
        state,
        inState.map((row) => row.task.taskId),
      ]),
    ).toEqual([
      ["needs-you", ["n1"]],
      ["failed", ["f1"]],
      ["working", ["w1", "w2"]],
      ["stopped", ["s1"]],
    ]);
  });

  it("returns no group for no row", () => {
    expect(groupTrackingRows([])).toEqual([]);
  });
});

describe("decideTrackingRowDestination", () => {
  const working = buildTask("a", buildRun("r1", 0, "running"));

  it("opens the run's page for a row that waits on nothing", () => {
    const row = buildTrackingRows([working], [], NO_YOUR_WORK)[0]!;
    expect(decideTrackingRowDestination(row)).toEqual({ kind: "run", runId: "r1" });
  });

  it("opens the thread of the session whose Request waits", () => {
    const row = buildTrackingRows(
      [working],
      [buildWaitingSession("s1", "r1", 7)],
      NO_YOUR_WORK,
    )[0]!;
    expect(decideTrackingRowDestination(row)).toEqual({ kind: "thread", sessionId: "s1" });
  });

  it("opens the signal that names the Task as Your work", () => {
    const yourWork = buildYourWork([[buildSignal("sig", 1), ["a"]]]);
    const row = buildTrackingRows([working], [], yourWork)[0]!;
    expect(decideTrackingRowDestination(row)).toEqual({ kind: "signal", signalId: "sig" });
  });
});
