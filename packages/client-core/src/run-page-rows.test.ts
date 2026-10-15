import { assert, describe, it } from "vitest";
import type { OpenRequest, Run, Session, StepRecord } from "@hercule/contract";
import {
  buildRunLead,
  buildStepTimeline,
  computeStepTimelineEnd,
  countStepTimelineRows,
  decideRunMark,
  describeRunState,
  describeRunWorkflow,
  ranOnEarlierVersion,
  type StepTimeline,
} from "./run-page-rows";
import { buildSession } from "./threads/workspaces.testing";

const START = "2026-09-24T12:00:00.000Z";
const at = (ms: number): string => new Date(Date.parse(START) + ms).toISOString();

const RUN_ID = "01a06d02-c111-7a0e-8b3d-9c1f1f3a9c2e";
const REVIEW_SESSION_ID = "01a06d02-c111-7a0e-8b3d-9c1f00005e55";

/**
 * A release: an issue label or the Friday schedule starts `build`, then
 * `review` drives an Agent's session, and `ship` ends the run. It declares
 * two inputs, `version` before `dryRun`.
 */
const PLAN: Run["plan"] = {
  name: "Release",
  inputs: [
    { name: "version", schema: { type: "string" }, required: true },
    { name: "dryRun", schema: { type: "boolean" }, required: false },
  ],
  triggers: [
    { id: "labeled", kind: "start", on: { kind: "github.issue.labeled" } },
    { id: "friday", kind: "start", on: { schedule: "0 14 * * 5" } },
  ],
  steps: [
    { id: "build", kind: "action", action: "task.create" },
    { id: "review", kind: "agent", agent: "a-reviewer", prompt: "Review the release." },
    { id: "ship", kind: "action", action: "task.update", terminal: true },
  ],
  edges: [
    { from: "build", to: "review" },
    { from: "review", to: "ship" },
  ],
};

/** The fields of a run that these tests set the same way. */
const RUN_FIELDS = {
  id: RUN_ID,
  workflowId: null,
  plan: PLAN,
  // `extra` is not declared, and `dryRun` comes before `version`.
  inputs: { extra: { channel: "beta" }, dryRun: false, version: "2.14.0" },
  origin: { kind: "trigger", triggerId: "labeled", eventId: 1 },
  subscriptions: [],
  createdAt: START,
  edgeTraversals: [1, 0],
} as const;

/** Returns a completed record of `stepId`, which ran from `from` to `to` milliseconds after the start. */
const complete = (stepId: string, from: number, to: number): StepRecord => ({
  stepId,
  iteration: 1,
  status: "completed",
  startedAt: at(from),
  finishedAt: at(to),
  output: { ok: true },
});

/** `build` took 20 seconds; `review` has run since 25 seconds in; `ship` has not run. */
const RUNNING: Run = {
  ...RUN_FIELDS,
  status: "running",
  startedAt: START,
  steps: [
    complete("build", 0, 20_000),
    {
      stepId: "review",
      iteration: 1,
      status: "running",
      startedAt: at(25_000),
      sessionId: REVIEW_SESSION_ID,
    },
  ],
};

/** The run, completed a minute in with a string output. */
const COMPLETED: Run = {
  ...RUN_FIELDS,
  status: "completed",
  startedAt: START,
  finishedAt: at(60_000),
  output: "2.14.0 shipped",
  steps: [
    complete("build", 0, 20_000),
    { ...complete("review", 25_000, 50_000), sessionId: REVIEW_SESSION_ID },
    complete("ship", 52_000, 60_000),
  ],
  edgeTraversals: [1, 1],
};

const COMMAND_REQUEST: OpenRequest = {
  requestId: "r-1",
  itemId: "tool-1",
  decisions: ["allow", "deny"],
  kind: "command_approval",
  detail: { command: "npm audit fix --force" },
};

/** The session of `review`, which asks the user to approve a command. */
const ASKING: Session = buildSession({
  id: REVIEW_SESSION_ID,
  runId: RUN_ID,
  stepId: "review",
  openRequests: [COMMAND_REQUEST],
});

/** The session of `review` with nothing to ask. */
const QUIET: Session = { ...ASKING, openRequests: [] };

describe("buildRunLead", () => {
  it("leads a running run with its state, its trigger and its inputs in the plan's order", () => {
    assert.deepStrictEqual(buildRunLead(RUNNING, [QUIET]), {
      mark: "working",
      stateText: "Running",
      ask: undefined,
      failure: undefined,
      startedBy: { text: "labeled", firesOn: "event" },
      inputs: [
        { name: "version", value: "2.14.0" },
        { name: "dryRun", value: "false" },
        { name: "extra", value: '{"channel":"beta"}' },
      ],
      output: undefined,
    });
  });

  it("asks what the run's waiting session asks, and names its step", () => {
    const lead = buildRunLead(RUNNING, [ASKING]);
    assert.strictEqual(lead.mark, "waiting");
    assert.strictEqual(lead.stateText, "Waiting on you");
    assert.deepStrictEqual(lead.ask, {
      question: "review asks: Run npm audit fix --force?",
      sessionId: REVIEW_SESSION_ID,
    });
  });

  it("ignores a session of another run that asks", () => {
    const other = { ...ASKING, runId: "01a06d02-c111-7a0e-8b3d-9c1f1f3a0000" };
    assert.strictEqual(buildRunLead(RUNNING, [other]).mark, "working");
  });

  it("asks nothing once the run has ended, though a session still has a Request open", () => {
    const cancelled: Run = {
      ...RUN_FIELDS,
      status: "cancelled",
      startedAt: START,
      finishedAt: at(30_000),
      steps: RUNNING.steps,
    };
    const lead = buildRunLead(cancelled, [ASKING]);
    assert.strictEqual(lead.mark, "cancelled");
    assert.strictEqual(lead.stateText, "Cancelled");
    assert.isUndefined(lead.ask);
    assert.isUndefined(lead.failure);
  });

  it("is starting while pending, and while running with no step started yet", () => {
    const pending: Run = { ...RUN_FIELDS, status: "pending", steps: [] };
    assert.strictEqual(buildRunLead(pending, []).mark, "starting");
    assert.strictEqual(buildRunLead(pending, []).stateText, "Starting");
    const between: Run = { ...RUN_FIELDS, status: "running", startedAt: START, steps: [] };
    assert.strictEqual(buildRunLead(between, []).mark, "starting");
  });

  it("is working while the run waits for a signal", () => {
    const listening: Run = {
      ...RUNNING,
      plan: {
        ...PLAN,
        triggers: [
          ...(PLAN.triggers ?? []),
          {
            id: "merged",
            kind: "signal",
            on: { kind: "github.pr.merged" },
            correlation: { event: "event.payload.number", run: "steps.ship.output.number" },
          },
        ],
      },
      steps: [complete("build", 0, 20_000)],
    };
    assert.strictEqual(buildRunLead(listening, []).mark, "working");
  });

  it("shows a completed run's output, as words for a string and as JSON otherwise", () => {
    const lead = buildRunLead(COMPLETED, []);
    assert.strictEqual(lead.mark, "done");
    assert.strictEqual(lead.stateText, "Completed");
    assert.deepStrictEqual(lead.output, { name: "Output", value: "2.14.0 shipped" });
    assert.deepStrictEqual(buildRunLead({ ...COMPLETED, output: { pr: 12 } }, []).output, {
      name: "Output",
      value: '{"pr":12}',
    });
  });

  it("says why a run failed at a step, with the step's error", () => {
    const failed: Run = {
      ...RUN_FIELDS,
      status: "failed",
      failureReason: "step-failed",
      failedStepId: "ship",
      startedAt: START,
      finishedAt: at(60_000),
      steps: [
        ...COMPLETED.steps.slice(0, 2),
        {
          stepId: "ship",
          iteration: 1,
          status: "failed",
          startedAt: at(52_000),
          finishedAt: at(60_000),
          error: { code: "push_rejected", message: "The remote rejected the push." },
        },
      ],
    };
    const lead = buildRunLead(failed, []);
    assert.strictEqual(lead.mark, "failed");
    assert.strictEqual(lead.stateText, "Failed");
    assert.strictEqual(lead.failure, "Step failed at ship. The remote rejected the push.");
    assert.isUndefined(lead.output);
  });

  it("says why a run failed at an edge, with the edge's message", () => {
    const failed: Run = {
      ...RUN_FIELDS,
      status: "failed",
      failureReason: "iteration-limit",
      failedStepId: "review",
      failedEdge: { index: 1, message: "The run would follow review → ship a fourth time." },
      startedAt: START,
      finishedAt: at(60_000),
      steps: COMPLETED.steps.slice(0, 2),
    };
    assert.strictEqual(
      buildRunLead(failed, []).failure,
      "Iteration limit at review. The run would follow review → ship a fourth time.",
    );
  });

  it("says why a run did not validate, and gives the reason alone when nothing says more", () => {
    const invalid: Run = {
      ...RUN_FIELDS,
      status: "failed",
      failureReason: "validation-error",
      failureMessage: "The input version is required.",
      finishedAt: START,
      steps: [],
    };
    assert.strictEqual(
      buildRunLead(invalid, []).failure,
      "Validation error. The input version is required.",
    );
    const broken: Run = {
      ...RUN_FIELDS,
      status: "failed",
      failureReason: "controller-error",
      finishedAt: START,
      steps: [],
    };
    assert.strictEqual(buildRunLead(broken, []).failure, "Controller error");
  });

  it("names a schedule trigger, the actor who started a run by hand, and a removed trigger", () => {
    const friday: Run = {
      ...RUNNING,
      origin: { kind: "trigger", triggerId: "friday", eventId: 2 },
    };
    assert.deepStrictEqual(buildRunLead(friday, []).startedBy, {
      text: "friday",
      firesOn: "schedule",
    });
    const manual: Run = { ...RUNNING, origin: { kind: "manual", actor: "user" } };
    assert.deepStrictEqual(buildRunLead(manual, []).startedBy, { text: "you", firesOn: null });
    const removed: Run = {
      ...RUNNING,
      origin: { kind: "trigger", triggerId: "gone", eventId: 3 },
    };
    assert.deepStrictEqual(buildRunLead(removed, []).startedBy, { text: "gone", firesOn: null });
  });

  it("names a trigger by its id alone, and says how an actor started the run", () => {
    const labeled: Run = {
      ...RUNNING,
      triggerEvent: {
        id: 1,
        source: "github",
        connectionId: null,
        system: "github",
        kind: "github.issue.labeled",
        occurredAt: START,
        receivedAt: START,
        dedupKey: "delivery-1",
        refs: [],
        url: null,
        payload: {},
        title: "Ship 2.14",
        author: null,
        actor: null,
      },
    };
    assert.deepStrictEqual(buildRunLead(labeled, []).startedBy, {
      text: "labeled",
      firesOn: "event",
    });
    const api: Run = { ...RUNNING, origin: { kind: "api", actor: "user" } };
    assert.deepStrictEqual(buildRunLead(api, []).startedBy, {
      text: "you through the API",
      firesOn: null,
    });
  });
});

describe("describeRunWorkflow", () => {
  it("names the run's workflow by its plan, linked while the workflow exists", () => {
    assert.deepStrictEqual(describeRunWorkflow({ ...RUNNING, workflowId: "w-1" }, false), {
      kind: "saved",
      workflowId: "w-1",
      name: "Release",
    });
  });

  it("says a deleted workflow is deleted, and still names it from the plan", () => {
    assert.deepStrictEqual(describeRunWorkflow({ ...RUNNING, workflowId: "w-1" }, true), {
      kind: "gone",
      name: "Release",
      reason: "deleted",
    });
  });

  it("says a workflow that was sent with the run was never saved", () => {
    assert.deepStrictEqual(describeRunWorkflow({ ...RUNNING, workflowId: null }, false), {
      kind: "gone",
      name: "Release",
      reason: "not saved",
    });
  });
});

describe("decideRunMark", () => {
  it("is waiting while a live run's session asks the user", () => {
    assert.strictEqual(decideRunMark(RUNNING, [ASKING]), "waiting");
  });

  it("follows the run's state when no session of it asks", () => {
    assert.strictEqual(decideRunMark(RUNNING, [QUIET]), "working");
    assert.strictEqual(decideRunMark(COMPLETED, [ASKING]), "done");
  });

  it("ignores a session of another run that asks", () => {
    assert.strictEqual(decideRunMark(RUNNING, [{ ...ASKING, runId: "other-run" }]), "working");
  });
});

describe("describeRunState", () => {
  it("says each mark in the words the run's lead leads with", () => {
    assert.strictEqual(describeRunState("waiting"), "Waiting on you");
    assert.strictEqual(describeRunState("working"), "Running");
    assert.strictEqual(describeRunState("done"), "Completed");
    assert.strictEqual(describeRunState("cancelled"), "Cancelled");
  });
});

describe("ranOnEarlierVersion", () => {
  it("is true only when the workflow changed after the run was created", () => {
    const run = { createdAt: START };
    assert.isTrue(ranOnEarlierVersion(run, { updatedAt: at(1) }));
    assert.isFalse(ranOnEarlierVersion(run, { updatedAt: START }));
    assert.isFalse(ranOnEarlierVersion(run, { updatedAt: at(-1) }));
  });
});

describe("buildStepTimeline", () => {
  /** An axis wide enough that only the most ticks an axis has limits the step. */
  const WIDE = 100;
  const nowAt = (ms: number): number => Date.parse(START) + ms;
  const listLabels = (timeline: StepTimeline): ReadonlyArray<string> =>
    timeline.ticks.map((tick) => tick.label);

  it("ends a live run's axis at the first tick after now, and leaves the running bar's end to the screen", () => {
    const timeline = buildStepTimeline(RUNNING, [QUIET], nowAt(43_000), WIDE);
    assert.strictEqual(timeline.originAt, START);
    assert.strictEqual(timeline.spanMs, 50_000);
    assert.deepStrictEqual(listLabels(timeline), ["0", "10s", "20s", "30s", "40s", "50s"]);
    assert.deepStrictEqual(timeline.rows, [
      {
        key: timeline.rows[0]!.key,
        stepId: "build",
        kind: "action",
        iterationLabel: undefined,
        state: "done",
        bar: { start: 0, end: 0.4 },
        note: undefined,
        startedAt: START,
        finishedAt: at(20_000),
        sessionId: undefined,
        errorText: undefined,
      },
      {
        key: timeline.rows[1]!.key,
        stepId: "review",
        kind: "agent",
        iterationLabel: undefined,
        state: "working",
        bar: { start: 0.5, end: undefined },
        note: undefined,
        startedAt: at(25_000),
        finishedAt: undefined,
        sessionId: REVIEW_SESSION_ID,
        errorText: undefined,
      },
      {
        key: timeline.rows[2]!.key,
        stepId: "ship",
        kind: "action",
        iterationLabel: undefined,
        state: "unreached",
        bar: undefined,
        note: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        sessionId: undefined,
        errorText: undefined,
      },
    ]);
    assert.strictEqual(new Set(timeline.rows.map((row) => row.key)).size, 3);
  });

  it("stays the same while a live run's labels stay the same, and moves on when they change", () => {
    const early = buildStepTimeline(RUNNING, [QUIET], nowAt(41_000), WIDE);
    const late = buildStepTimeline(RUNNING, [QUIET], nowAt(49_999), WIDE);
    assert.deepStrictEqual(late, early);
    const later = buildStepTimeline(RUNNING, [QUIET], nowAt(50_001), WIDE);
    assert.strictEqual(later.spanMs, 60_000);
    assert.deepStrictEqual(listLabels(later), ["0", "10s", "20s", "30s", "40s", "50s", "1m"]);
    assert.deepStrictEqual(later.rows[0]?.bar, { start: 0, end: 20 / 60 });
  });

  it("ends a live run's timeline where its axis ends, and builds the same timeline there as at now", () => {
    // 16 characters fit a tick every 15 seconds; 1 character fits no second
    // tick, so the axis is as long as the longest step it could use.
    for (const width of [WIDE, 16, 1]) {
      const end = computeStepTimelineEnd(RUNNING, nowAt(43_000), width);
      const atNow = buildStepTimeline(RUNNING, [QUIET], nowAt(43_000), width);
      assert.strictEqual(end, nowAt(atNow.spanMs));
      assert.deepStrictEqual(buildStepTimeline(RUNNING, [QUIET], end, width), atNow);
    }
    assert.strictEqual(computeStepTimelineEnd(RUNNING, nowAt(49_999), WIDE), nowAt(50_000));
  });

  it("ends an ended run's timeline where the run ended, whatever now is", () => {
    assert.strictEqual(
      computeStepTimelineEnd(COMPLETED, nowAt(3_600_000), WIDE),
      Date.parse(COMPLETED.finishedAt),
    );
  });

  it("counts a row per step record and per plan step the run has not reached", () => {
    const timeline = buildStepTimeline(RUNNING, [QUIET], nowAt(43_000), WIDE);
    assert.strictEqual(countStepTimelineRows(RUNNING), timeline.rows.length);
    assert.strictEqual(countStepTimelineRows(RUNNING), 3);
  });

  it("keeps a live run's labels apart on a narrow axis", () => {
    // On 16 characters, a tick every 10 seconds would put labels 3.2
    // characters apart; a tick every 15 seconds puts them 5.3 apart.
    const narrow = buildStepTimeline(RUNNING, [QUIET], nowAt(43_000), 16);
    assert.strictEqual(narrow.spanMs, 45_000);
    assert.deepStrictEqual(listLabels(narrow), ["0", "15s", "30s", "45s"]);
  });

  it("marks the row of a running step whose session asks as waiting", () => {
    const timeline = buildStepTimeline(RUNNING, [ASKING], nowAt(43_000), WIDE);
    assert.strictEqual(timeline.rows[1]?.state, "waiting");
  });

  it("ends an ended run's axis where the run ended, with every bar's end", () => {
    const timeline = buildStepTimeline(COMPLETED, [], nowAt(3_600_000), WIDE);
    assert.strictEqual(timeline.spanMs, 60_000);
    assert.deepStrictEqual(listLabels(timeline), ["0", "10s", "20s", "30s", "40s", "50s", "1m"]);
    assert.deepStrictEqual(
      timeline.rows.map((row) => [row.stepId, row.state, row.bar?.start, row.bar?.end]),
      [
        ["build", "done", 0, 20 / 60],
        ["review", "done", 25 / 60, 50 / 60],
        ["ship", "done", 52 / 60, 1],
      ],
    );
  });

  it("leaves a step an ended run did not reach without a note, and gives a failed step's error", () => {
    const failed: Run = {
      ...RUN_FIELDS,
      status: "failed",
      failureReason: "step-failed",
      failedStepId: "review",
      startedAt: START,
      finishedAt: at(40_000),
      steps: [
        complete("build", 0, 20_000),
        {
          stepId: "review",
          iteration: 1,
          status: "failed",
          startedAt: at(25_000),
          finishedAt: at(40_000),
          error: { code: "session_failed", message: "The session exited." },
          sessionId: REVIEW_SESSION_ID,
        },
      ],
    };
    const timeline = buildStepTimeline(failed, [], nowAt(90_000), WIDE);
    assert.deepStrictEqual(
      timeline.rows.map((row) => [row.stepId, row.state, row.errorText, row.note]),
      [
        ["build", "done", undefined, undefined],
        ["review", "failed", "The session exited.", undefined],
        ["ship", "unreached", undefined, undefined],
      ],
    );
  });

  it("notes a queued step as waiting to start, and a skipped one as skipped", () => {
    const queued: Run = {
      ...RUNNING,
      steps: [
        complete("build", 0, 20_000),
        { stepId: "review", iteration: 1, status: "pending" },
        { stepId: "ship", iteration: 1, status: "skipped", finishedAt: at(30_000) },
      ],
    };
    const timeline = buildStepTimeline(queued, [], nowAt(43_000), WIDE);
    assert.deepStrictEqual(
      timeline.rows.map((row) => [row.stepId, row.bar === undefined, row.note]),
      [
        ["build", false, undefined],
        ["review", true, "Waiting to start"],
        ["ship", true, "skipped"],
      ],
    );
  });

  it("starts the axis of a run that never started where it was created", () => {
    const pending: Run = { ...RUN_FIELDS, status: "pending", steps: [] };
    const timeline = buildStepTimeline(pending, [], nowAt(3_000), WIDE);
    assert.strictEqual(timeline.originAt, START);
    assert.strictEqual(timeline.spanMs, 3_000);
  });
});
