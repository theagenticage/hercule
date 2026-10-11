import { assert, describe, it } from "vitest";
import type { RunSummary, Trigger, TriggerOn, WorkflowDefinition } from "@hercule/contract";
import type { WaitingRunSession } from "./waiting";
import {
  buildInputRows,
  buildRunRows,
  buildTriggerRows,
  buildWorkflowChips,
  describeRunRow,
  formatRunDuration,
  type RunRow,
} from "./workflow-detail-rows";

const AT = "2026-09-01T00:00:00.000Z";

/**
 * A release: an issue label or the Friday schedule starts it, two agents and
 * an action do the work, and the `merged` signal resumes the run once its
 * pull request is merged.
 */
const RELEASE: WorkflowDefinition = {
  name: "Release",
  inputs: [
    { name: "version", schema: { type: "string" }, required: true },
    { name: "repo", connection: { type: "github/github" }, required: false },
    { name: "dry_run", schema: { type: "boolean" }, required: false, default: false },
    { name: "channel", schema: { enum: ["stable", "beta"] }, required: false },
    { name: "request", signal: { kinds: ["github/review-requested"] }, required: false },
  ],
  triggers: [
    { id: "labeled", kind: "start", on: { kind: "github.issue.labeled" } },
    { id: "friday", kind: "start", on: { schedule: "0 14 * * 5" } },
    {
      id: "merged",
      kind: "signal",
      on: { kind: "github.pr.merged" },
      correlation: { event: "event.payload.number", run: "steps.open_pr.output.number" },
    },
  ],
  steps: [
    { id: "notes", kind: "agent", agent: "a-writer", prompt: "Write the notes." },
    { id: "review", kind: "agent", agent: "a-reviewer", prompt: "Review." },
    { id: "open_pr", kind: "action", action: "github/pr.create" },
  ],
};

/** Returns the record of the trigger `triggerId` of the release, firing on `on`. */
const buildTrigger = (
  triggerId: string,
  kind: Trigger["kind"],
  on: TriggerOn,
  fields: Partial<Trigger> = {},
): Trigger => ({
  workflowId: "w-release",
  workflowName: "Release",
  triggerId,
  kind,
  on,
  ...(kind === "start" ? { status: "active", health: { state: "ok" } } : {}),
  createdAt: AT,
  updatedAt: AT,
  ...fields,
});

const LABELED = buildTrigger("labeled", "start", { kind: "github.issue.labeled" });
const FRIDAY = buildTrigger(
  "friday",
  "start",
  { schedule: "0 14 * * 5" },
  { nextFireAt: "2026-10-02T14:00:00.000Z" },
);
const MERGED = buildTrigger("merged", "signal", { kind: "github.pr.merged" });
const BROKEN = { state: "error", message: "No such key: labels", at: AT } as const;

describe("buildWorkflowChips", () => {
  it("lists each start trigger with its next fire for the screen to format, then what the steps run", () => {
    assert.deepStrictEqual(buildWorkflowChips(RELEASE, true, [MERGED, FRIDAY, LABELED]), [
      {
        key: "trigger:labeled",
        firesOn: "event",
        text: "github.issue.labeled",
        nextFireAt: null,
        tone: null,
      },
      {
        key: "trigger:friday",
        firesOn: "schedule",
        text: "Fridays at 14:00",
        nextFireAt: "2026-10-02T14:00:00.000Z",
        tone: null,
      },
      {
        key: "steps",
        firesOn: null,
        text: "2 agents · 1 action · 1 signal",
        nextFireAt: null,
        tone: null,
      },
    ]);
  });

  it("says when a start trigger is in error or paused, and then gives no next fire", () => {
    const chips = buildWorkflowChips(RELEASE, true, [
      { ...LABELED, health: BROKEN },
      { ...FRIDAY, status: "paused" },
    ]);
    assert.deepStrictEqual(
      chips.slice(0, 2).map(({ text, tone, nextFireAt }) => ({ text, tone, nextFireAt })),
      [
        { text: "github.issue.labeled · error", tone: "fail", nextFireAt: null },
        { text: "Fridays at 14:00 · paused", tone: null, nextFireAt: null },
      ],
    );
  });

  it("gives no next fire while the workflow is off", () => {
    assert.isNull(buildWorkflowChips(RELEASE, false, [FRIDAY])[0]?.nextFireAt);
  });

  it("says a workflow with no start trigger runs on demand", () => {
    assert.deepStrictEqual(
      buildWorkflowChips(RELEASE, true, [MERGED]).map((chip) => chip.text),
      ["On demand", "2 agents · 1 action · 1 signal"],
    );
  });
});

const CREATED = "2026-09-29T09:12:00.000Z";
const FINISHED = "2026-09-29T09:52:00.000Z";
const BY_LABEL = { kind: "trigger", triggerId: "labeled", eventId: 1 } as const;
const FIELDS = { workflowId: "w-release", workflowName: "Release", origin: BY_LABEL };

const AT_REVIEW: RunSummary = {
  ...FIELDS,
  id: "r-review",
  createdAt: CREATED,
  status: "running",
  startedAt: CREATED,
  activeStepIds: ["review"],
  awaitedSignalIds: [],
};

/** Builds the session of `runId` that waits on the user with `question`. */
const buildWaiting = (runId: string, question: string, activityAt: string): WaitingRunSession => ({
  sessionId: `s-${question}`,
  runId,
  stepId: "review",
  title: "Release · review",
  question,
  activityAt,
});

/** Builds the row of one run, with no session waiting on the user unless given. */
const buildRow = (run: RunSummary, waiting: ReadonlyArray<WaitingRunSession> = []): RunRow => {
  const [row] = buildRunRows([run], RELEASE, waiting);
  assert.isDefined(row);
  return row;
};

describe("buildRunRows", () => {
  it("draws a live run that waits on the user with the question that has waited longest", () => {
    const row = buildRow(AT_REVIEW, [
      buildWaiting("r-review", "Ship v2.4?", "2026-09-29T09:40:00.000Z"),
      buildWaiting("r-review", "Run npm audit?", "2026-09-29T09:30:00.000Z"),
      buildWaiting("r-other", "Push?", "2026-09-29T09:20:00.000Z"),
    ]);
    assert.deepStrictEqual(row, {
      id: "r-review",
      state: "waiting",
      statusText: "review asks: Run npm audit?",
      statusTone: "you",
      startedByText: "labeled",
      startedByFiresOn: "event",
      createdAt: CREATED,
      startedAt: CREATED,
      finishedAt: null,
      isLive: true,
    });
  });

  it("says where a live run is, not just that it runs", () => {
    const awaiting: RunSummary = { ...AT_REVIEW, activeStepIds: [], awaitedSignalIds: ["merged"] };
    assert.deepInclude(buildRow(AT_REVIEW), { state: "working", statusText: "At review" });
    assert.deepInclude(buildRow(awaiting), {
      state: "working",
      statusText: "Waiting for merged",
    });
  });

  it("gives a run that has not started a step no mark, and says it is starting", () => {
    const pending: RunSummary = {
      ...FIELDS,
      id: "r-pending",
      createdAt: CREATED,
      status: "pending",
    };
    assert.deepInclude(buildRow(pending), {
      state: "starting",
      statusText: "Starting",
      statusTone: "muted",
      startedAt: null,
    });
  });

  it("says how an ended run ended, and why and where a failed one failed", () => {
    const ended = { ...FIELDS, createdAt: CREATED, startedAt: CREATED, finishedAt: FINISHED };
    const rows = buildRunRows(
      [
        { ...ended, id: "r-done", status: "completed" },
        { ...ended, id: "r-cancelled", status: "cancelled" },
        {
          ...ended,
          id: "r-limit",
          status: "failed",
          failureReason: "iteration-limit",
          failedStepId: "review",
        },
        {
          ...FIELDS,
          id: "r-invalid",
          createdAt: CREATED,
          status: "failed",
          failureReason: "validation-error",
          failureMessage: "version is required",
          finishedAt: CREATED,
        },
      ],
      RELEASE,
      // A session left over from an ended run does not make it wait.
      [buildWaiting("r-done", "Ship?", CREATED)],
    );
    assert.deepStrictEqual(
      rows.map(({ state, statusText, statusTone }) => [state, statusText, statusTone]),
      [
        ["done", "Completed", "muted"],
        ["cancelled", "Cancelled", "muted"],
        ["failed", "Iteration limit at review", "fail"],
        ["failed", "Validation error", "fail"],
      ],
    );
  });

  it("says who or what started a run, with the clock or the bolt of its trigger", () => {
    const readStartedBy = (origin: RunSummary["origin"]) => {
      const row = buildRow({ ...AT_REVIEW, origin });
      return [row.startedByText, row.startedByFiresOn];
    };
    assert.deepStrictEqual(readStartedBy({ kind: "trigger", triggerId: "friday", eventId: 2 }), [
      "friday",
      "schedule",
    ]);
    assert.deepStrictEqual(readStartedBy({ kind: "manual", actor: "user" }), ["You", null]);
    // The workflow no longer declares the trigger, so no icon is drawn.
    assert.deepStrictEqual(readStartedBy({ kind: "trigger", triggerId: "nightly", eventId: 3 }), [
      "nightly",
      null,
    ]);
  });
});

describe("formatRunDuration", () => {
  it("counts a live run's duration up to now, and stops at an ended run's end", () => {
    const now = Date.parse("2026-09-29T09:41:00.000Z");
    assert.strictEqual(formatRunDuration(buildRow(AT_REVIEW), now), "29m 0s");
    const done = buildRow({ ...AT_REVIEW, status: "completed", finishedAt: FINISHED });
    assert.strictEqual(formatRunDuration(done, now), "40m 0s");
  });

  it("gives a run that never started no duration", () => {
    const pending: RunSummary = {
      ...FIELDS,
      id: "r-pending",
      createdAt: CREATED,
      status: "pending",
    };
    assert.strictEqual(formatRunDuration(buildRow(pending), Date.parse(FINISHED)), "");
  });
});

describe("describeRunRow", () => {
  it("names a run's status, who started it, when, and how long it took or has run", () => {
    const done = buildRow({ ...AT_REVIEW, status: "completed", finishedAt: FINISHED });
    assert.strictEqual(
      describeRunRow(done, "09:01", "40m 0s"),
      "Completed, started by labeled, 09:01, took 40m 0s",
    );
    assert.strictEqual(
      describeRunRow(buildRow(AT_REVIEW), "09:01", "29m 0s"),
      "At review, started by labeled, 09:01, running for 29m 0s",
    );
  });

  it("says no duration for a run that never started", () => {
    const pending = buildRow({ ...FIELDS, id: "r-pending", createdAt: CREATED, status: "pending" });
    assert.strictEqual(describeRunRow(pending, "09:01", ""), "Starting, started by labeled, 09:01");
  });
});

describe("buildTriggerRows", () => {
  it("lists the triggers in the order the definition declares them, with what each does", () => {
    const rows = buildTriggerRows(RELEASE, true, [MERGED, FRIDAY, LABELED]);
    assert.deepStrictEqual(
      rows.map((row) => [row.id, row.firesOn, row.doesText, row.firesOnText, row.stateText]),
      [
        ["labeled", "event", "Starts a run", "github.issue.labeled", "On event"],
        ["friday", "schedule", "Starts a run", "Fridays at 14:00", ""],
        ["merged", "event", "Resumes a run", "github.pr.merged", ""],
      ],
    );
    assert.strictEqual(rows[1]?.nextFireAt, "2026-10-02T14:00:00.000Z");
  });

  it("puts a trigger's error before its paused state", () => {
    const [row] = buildTriggerRows(RELEASE, true, [
      { ...FRIDAY, status: "paused", health: BROKEN },
    ]);
    assert.deepInclude(row, {
      stateText: "No such key: labels",
      stateTone: "fail",
      nextFireAt: null,
    });
  });

  it("says a start trigger is paused, or off while its workflow is off, with no next fire", () => {
    const [paused] = buildTriggerRows(RELEASE, true, [{ ...FRIDAY, status: "paused" }]);
    assert.deepInclude(paused, { stateText: "Paused", nextFireAt: null });
    const [off] = buildTriggerRows(RELEASE, false, [FRIDAY]);
    assert.deepInclude(off, { stateText: "Off", nextFireAt: null });
  });

  it("gives each start trigger a pause switch, named for it, and a signal trigger none", () => {
    const rows = buildTriggerRows(RELEASE, false, [
      { ...FRIDAY, status: "paused" },
      LABELED,
      MERGED,
    ]);
    assert.deepStrictEqual(
      rows.map((row) => row.switch),
      [
        { isActive: true, label: "labeled starts runs" },
        { isActive: false, label: "friday starts runs" },
        null,
      ],
    );
  });
});

describe("buildInputRows", () => {
  it("describes each input's type, whether it is required, and its default as JSON", () => {
    assert.deepStrictEqual(buildInputRows(RELEASE), [
      { name: "version", typeText: "string", requiredText: "Required", defaultText: "" },
      {
        name: "repo",
        typeText: "github/github connection",
        requiredText: "Optional",
        defaultText: "",
      },
      { name: "dry_run", typeText: "boolean", requiredText: "Optional", defaultText: "false" },
      // A schema with no single type is shown as JSON.
      { name: "channel", typeText: "JSON", requiredText: "Optional", defaultText: "" },
      {
        name: "request",
        typeText: "github/review-requested signal",
        requiredText: "Optional",
        defaultText: "",
      },
    ]);
  });
});
