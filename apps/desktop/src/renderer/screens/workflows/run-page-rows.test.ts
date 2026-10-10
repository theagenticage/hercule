import { describe, expect, it } from "vitest";
import { buildSession } from "@hercule/client-core/threads/testing";
import { buildTimeline, parseWorkflowSourceWithRanges } from "@hercule/client-core";
import {
  renderWorkflowSource,
  type Run,
  type Session,
  type StepRecord,
  type WorkflowDefinition,
} from "@hercule/contract";
import {
  buildRunLead,
  buildStepTimelineRows,
  describeRunDuration,
  isPlanCurrent,
  listInputFacts,
} from "./run-page-rows";

const STARTED = "2026-09-29T09:00:00.000Z";
const NOW = new Date("2026-09-29T09:10:00.000Z");
const REVIEWER_ID = "01a0ec64-6e80-7000-8000-a00000000001";
const CODER_ID = "01a0ec64-6e80-7000-8000-a00000000002";

/**
 * A pull request's review: a label or a nightly schedule starts `review`,
 * which loops through `fix` until it approves; `open_pr` then opens the
 * pull request.
 */
const REVIEW: WorkflowDefinition = {
  name: "Review",
  inputs: [
    { name: "version", schema: { type: "string" }, required: true },
    { name: "dry_run", schema: { type: "boolean" }, required: false, default: false },
  ],
  triggers: [
    { id: "labeled", kind: "start", on: { kind: "github.issue.labeled" } },
    { id: "nightly", kind: "start", on: { schedule: "0 2 * * *" } },
  ],
  steps: [
    { id: "review", kind: "agent", agent: REVIEWER_ID, prompt: "Review the change." },
    { id: "fix", kind: "agent", agent: CODER_ID, prompt: "Fix what the review found." },
    { id: "open_pr", kind: "action", action: "github/pr.create" },
  ],
  edges: [
    { from: "review", to: "fix", condition: 'steps.review.output.verdict == "changes"' },
    { from: "fix", to: "review", maxTraversals: 3 },
    { from: "review", to: "open_pr", condition: 'steps.review.output.verdict == "approved"' },
  ],
};

/** Returns a completed step record of `stepId` that ran from `startedAt` to `finishedAt`. */
const complete = (
  stepId: string,
  iteration: number,
  startedAt: string,
  finishedAt: string,
): StepRecord => ({
  stepId,
  iteration,
  status: "completed",
  startedAt,
  finishedAt,
  output: null,
});

/** The fields of a run that no test here reads. */
const RUN_FIELDS = {
  id: "r-1",
  workflowId: "w-1",
  plan: REVIEW,
  inputs: { version: "2.14.0" },
  origin: { kind: "trigger", triggerId: "labeled", eventId: 1 },
  subscriptions: [],
  createdAt: STARTED,
  startedAt: STARTED,
  edgeTraversals: [1, 0, 0],
} as const;

/** `review` asked for changes, `fix` made them, and `review` runs again. */
const RUNNING: Run = {
  ...RUN_FIELDS,
  status: "running",
  steps: [
    complete("review", 1, STARTED, "2026-09-29T09:02:00.000Z"),
    complete("fix", 1, "2026-09-29T09:02:00.000Z", "2026-09-29T09:06:00.000Z"),
    {
      stepId: "review",
      iteration: 2,
      status: "running",
      startedAt: "2026-09-29T09:06:00.000Z",
      sessionId: "s-review",
    },
  ],
};

/** `review` on its second pass, with a command waiting on the user's approval. */
const ASKING_SESSION: Session = buildSession({
  id: "s-review",
  runId: "r-1",
  stepId: "review",
  openRequests: [
    {
      requestId: "q-1",
      itemId: "i-1",
      kind: "command_approval",
      decisions: ["allow", "deny"],
      detail: { command: "git push" },
    },
  ],
});

/** `review` sent the run through `fix` once more than the edge allows. */
const FAILED: Run = {
  ...RUN_FIELDS,
  status: "failed",
  failureReason: "iteration-limit",
  failedStepId: "review",
  failedEdge: {
    index: 0,
    message: "The run would follow review → fix a fourth time, past its limit of 3.",
  },
  finishedAt: "2026-09-29T09:40:00.000Z",
  steps: [complete("review", 1, STARTED, "2026-09-29T09:40:00.000Z")],
};

const COMPLETED: Run = {
  ...RUN_FIELDS,
  status: "completed",
  finishedAt: "2026-09-29T10:23:00.000Z",
  steps: [complete("review", 1, STARTED, "2026-09-29T10:23:00.000Z")],
};

describe("buildRunLead", () => {
  it("leads a live run with what its step asks the user", () => {
    expect(buildRunLead(RUNNING, [ASKING_SESSION], "UTC", NOW)).toEqual({
      mark: "waiting",
      title: "Waiting on you",
      gist: { text: "review asks: Run git push?", tone: "you" },
      askingSessionId: "s-review",
      startedBy: { source: "event", text: "labeled" },
      timeText: "Today 09:00",
    });
  });

  it("leads a live run that asks nothing with its status", () => {
    const lead = buildRunLead(RUNNING, [], "UTC", NOW);
    expect(lead).toMatchObject({ mark: "working", title: "Running", gist: undefined });
    expect(lead.askingSessionId).toBeUndefined();
  });

  it("leads a failed run with its reason, its step and the edge's message", () => {
    expect(buildRunLead(FAILED, [], "UTC", NOW)).toMatchObject({
      mark: "failed",
      title: "Failed",
      gist: {
        text: "Iteration limit at review. The run would follow review → fix a fourth time, past its limit of 3.",
        tone: "fail",
      },
    });
  });

  it("ignores an open Request once the run has ended", () => {
    const lead = buildRunLead(COMPLETED, [ASKING_SESSION], "UTC", NOW);
    expect(lead).toMatchObject({ mark: "done", title: "Completed", gist: undefined });
    expect(lead.askingSessionId).toBeUndefined();
  });

  it("names the trigger that started the run, with what it fires on", () => {
    const nightly: Run = {
      ...COMPLETED,
      origin: { kind: "trigger", triggerId: "nightly", eventId: 2 },
    };
    expect(buildRunLead(nightly, [], "UTC", NOW).startedBy).toEqual({
      source: "schedule",
      text: "nightly",
    });
  });

  it("says the user started a run they started by hand", () => {
    const manual: Run = { ...COMPLETED, origin: { kind: "manual", actor: "user" } };
    expect(buildRunLead(manual, [], "UTC", NOW).startedBy).toEqual({
      source: undefined,
      text: "you",
    });
  });
});

describe("describeRunDuration", () => {
  it("counts a live run up to now, and an ended run up to its end", () => {
    expect(describeRunDuration(RUNNING, NOW.getTime())).toBe("10m 0s");
    expect(describeRunDuration(COMPLETED, NOW.getTime())).toBe("1h 23m");
  });
});

describe("listInputFacts", () => {
  it("lists the inputs in the order the plan declares them, then any other, with non-strings as JSON", () => {
    const run: Run = {
      ...COMPLETED,
      inputs: { extra: { tag: "rc" }, dry_run: true, version: "2.14.0" },
    };
    expect(listInputFacts(run)).toEqual([
      { name: "version", value: "2.14.0" },
      { name: "dry_run", value: "true" },
      { name: "extra", value: '{"tag":"rc"}' },
    ]);
  });
});

describe("isPlanCurrent", () => {
  it("finds a plan current when the saved workflow parses back to the same definition", () => {
    const saved = parseWorkflowSourceWithRanges(renderWorkflowSource(REVIEW)).definition;
    expect(saved).toBeDefined();
    expect(isPlanCurrent(REVIEW, saved!)).toBe(true);
  });

  it("finds a plan current whatever the order of its fields", () => {
    const { steps, name, ...rest } = REVIEW;
    expect(isPlanCurrent(REVIEW, { steps, ...rest, name })).toBe(true);
  });

  it("finds a plan earlier when a step's prompt has changed since", () => {
    const edited: WorkflowDefinition = {
      ...REVIEW,
      steps: REVIEW.steps.map((step) =>
        step.id === "fix" ? { ...step, prompt: "Fix what the review found, then test it." } : step,
      ),
    };
    expect(isPlanCurrent(REVIEW, edited)).toBe(false);
  });
});

describe("buildStepTimelineRows", () => {
  const timeline = buildStepTimelineRows(RUNNING, [ASKING_SESSION], NOW.getTime(), 80);

  it("draws one row per step record, then one per step the run has not reached", () => {
    expect(
      timeline.rows.map(({ stepId, iterationLabel, mark, tone, durationText }) => ({
        stepId,
        iterationLabel,
        mark,
        tone,
        durationText,
      })),
    ).toEqual([
      {
        stepId: "review",
        iterationLabel: "#1",
        mark: "done",
        tone: undefined,
        durationText: "2m 0s",
      },
      {
        stepId: "fix",
        iterationLabel: undefined,
        mark: "done",
        tone: undefined,
        durationText: "4m 0s",
      },
      {
        stepId: "review",
        iterationLabel: "#2",
        mark: "waiting",
        tone: "you",
        durationText: "4m 0s",
      },
      {
        stepId: "open_pr",
        iterationLabel: undefined,
        mark: undefined,
        tone: undefined,
        durationText: "",
      },
    ]);
    expect(timeline.rows[2]?.sessionId).toBe("s-review");
  });

  it("marks a running step that asks nothing as working", () => {
    const rows = buildStepTimelineRows(RUNNING, [], NOW.getTime(), 80).rows;
    expect(rows[2]).toMatchObject({ mark: "working", tone: undefined });
  });

  /** Returns the labels of the axis ticks `buildStepTimelineRows` keeps for `run`, at `width` characters. */
  const listTickLabels = (run: Run, width: number): ReadonlyArray<string> =>
    buildStepTimelineRows(run, [], NOW.getTime(), width).ticks.map((tick) => tick.label);

  it("ends a live run's axis at now, and leaves out the ticks the now label would cover", () => {
    expect(timeline.nowText).toBe("now 10m 0s");
    // The axis has ticks every 2 minutes, from 0 to 10m; "now 10m 0s" covers 10m.
    expect(listTickLabels(RUNNING, 80)).toEqual(["0", "2m", "4m", "6m", "8m"]);
    // On a narrower axis, the label also covers 8m.
    expect(listTickLabels(RUNNING, 40)).toEqual(["0", "2m", "4m", "6m"]);
  });

  it("has no now label once the run has ended, keeps every tick, and colours the failed step's bar", () => {
    const failedAtStep: Run = {
      ...FAILED,
      failureReason: "step-failed",
      steps: [
        {
          stepId: "review",
          iteration: 1,
          status: "failed",
          startedAt: STARTED,
          finishedAt: "2026-09-29T09:40:00.000Z",
          error: { code: "unexpected", message: "The reviewer crashed." },
        },
      ],
    };
    const ended = buildStepTimelineRows(failedAtStep, [], NOW.getTime(), 80);
    expect(ended.nowText).toBeUndefined();
    expect(ended.ticks).toEqual(buildTimeline(failedAtStep, NOW.getTime(), 80).ticks);
    expect(ended.rows[0]).toMatchObject({
      mark: "failed",
      tone: "fail",
      errorText: "The reviewer crashed.",
    });
  });
});
