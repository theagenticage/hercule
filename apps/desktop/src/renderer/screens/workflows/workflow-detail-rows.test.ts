import { describe, expect, it } from "vitest";
import { buildSession } from "@hercule/client-core/threads/testing";
import type { RunSummary, Trigger, TriggerOn, WorkflowDefinition } from "@hercule/contract";
import {
  buildInputRows,
  buildRunRow,
  buildTriggerRows,
  buildWorkflowChips,
  describeRunRow,
} from "./workflow-detail-rows";

// Tuesday 29 September 2026, 09:41 UTC.
const NOW = new Date(Date.UTC(2026, 8, 29, 9, 41));
const AT = "2026-09-01T00:00:00.000Z";

/**
 * A release: an issue label or the Friday schedule starts it, two agents
 * and an action do the work, and the `merged` signal resumes the run once
 * its pull request is merged.
 */
const RELEASE: WorkflowDefinition = {
  name: "Release",
  inputs: [
    { name: "version", schema: { type: "string" }, required: true },
    { name: "repo", connection: { type: "github/github" }, required: false },
    { name: "dry_run", schema: { type: "boolean" }, required: false, default: false },
    { name: "channel", schema: { enum: ["stable", "beta"] }, required: false },
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

/** Returns trigger `triggerId` of the release, firing on `on`. */
const buildTrigger = (
  triggerId: string,
  kind: Trigger["kind"],
  on: TriggerOn,
  extra: Partial<Trigger> = {},
): Trigger => ({
  workflowId: "release",
  workflowName: "Release",
  triggerId,
  kind,
  on,
  ...(kind === "start" ? { status: "active", health: { state: "ok" } } : {}),
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

const LABELED = buildTrigger("labeled", "start", { kind: "github.issue.labeled" });
const FRIDAY = buildTrigger(
  "friday",
  "start",
  { schedule: "0 14 * * 5" },
  { nextFireAt: "2026-10-02T14:00:00.000Z" },
);
const MERGED = buildTrigger("merged", "signal", { kind: "github.pr.merged" });
const TRIGGERS = [LABELED, FRIDAY, MERGED];

const FIELDS = {
  workflowId: "release",
  workflowName: "Release",
  createdAt: "2026-09-29T09:12:00.000Z",
};
const BY_LABEL = { kind: "trigger", triggerId: "labeled", eventId: 1 } as const;

const SESSIONS = [
  buildSession({
    id: "s-review",
    runId: "r-waiting",
    stepId: "review",
    openRequests: [
      {
        requestId: "q-1",
        itemId: "i-1",
        kind: "command_approval",
        decisions: ["allow", "deny"],
        detail: { command: "npm audit fix --force" },
      },
    ],
  }),
];

/** Returns the row of `run`, with the sessions above and the release's definition. */
const buildRow = (run: RunSummary) => buildRunRow(run, RELEASE, SESSIONS, "UTC", NOW);

describe("buildWorkflowChips", () => {
  it("lists each start trigger with when it next fires, then what the steps run", () => {
    expect(buildWorkflowChips(RELEASE, true, TRIGGERS, "UTC", NOW)).toEqual([
      { key: "trigger:labeled", source: "event", text: "github.issue.labeled", tone: undefined },
      {
        key: "trigger:friday",
        source: "schedule",
        text: "Fridays at 14:00 · next Fri 14:00",
        tone: undefined,
      },
      { key: "steps", source: undefined, text: "2 agents · 1 action · 1 signal", tone: undefined },
    ]);
  });

  it("says when a start trigger is paused or in error, an error in the failure tone", () => {
    const chips = buildWorkflowChips(
      RELEASE,
      true,
      [
        { ...LABELED, health: { state: "error", message: "No such key: labels", at: AT } },
        { ...FRIDAY, status: "paused" },
      ],
      "UTC",
      NOW,
    );
    expect(chips.slice(0, 2).map((chip) => [chip.text, chip.tone])).toEqual([
      ["github.issue.labeled · error", "fail"],
      ["Fridays at 14:00 · paused", undefined],
    ]);
  });

  it("says a workflow with no start trigger starts on demand, enabled or not", () => {
    const chips = buildWorkflowChips(RELEASE, false, [MERGED], "UTC", NOW);
    expect(chips.map((chip) => chip.text)).toEqual(["On demand", "2 agents · 1 action · 1 signal"]);
  });

  it("leaves out when a disabled workflow's trigger would next fire", () => {
    const chips = buildWorkflowChips(RELEASE, false, [FRIDAY], "UTC", NOW);
    expect(chips[0]?.text).toBe("Fridays at 14:00");
  });
});

describe("buildRunRow", () => {
  it("draws a live run that waits on the user with what its step asks", () => {
    expect(
      buildRow({
        ...FIELDS,
        id: "r-waiting",
        origin: BY_LABEL,
        status: "running",
        startedAt: FIELDS.createdAt,
      }),
    ).toEqual({
      id: "r-waiting",
      mark: "waiting",
      status: { text: "review asks: Run npm audit fix --force?", tone: "you" },
      startedBy: { source: "event", text: "labeled" },
      isLive: true,
      durationText: "29m 0s",
      timeText: "09:12",
    });
  });

  it("says why a failed run failed, and at which step when it failed at one", () => {
    const failedAt = {
      ...FIELDS,
      id: "r-failed",
      origin: BY_LABEL,
      status: "failed",
      failureReason: "iteration-limit",
      failedStepId: "review",
      startedAt: FIELDS.createdAt,
      finishedAt: "2026-09-29T09:52:00.000Z",
    } as const;
    expect(buildRow(failedAt)).toMatchObject({
      mark: "failed",
      status: { text: "Iteration limit at review", tone: "fail" },
      durationText: "40m 0s",
    });
    expect(
      buildRow({
        ...FIELDS,
        id: "r-invalid",
        origin: BY_LABEL,
        status: "failed",
        failureReason: "validation-error",
        failureMessage: "version is required",
        finishedAt: FIELDS.createdAt,
      }).status,
    ).toEqual({ text: "Validation error", tone: "fail" });
  });

  it("says who or what started a run, with the clock or the bolt of its trigger", () => {
    const started = (origin: RunSummary["origin"]) =>
      buildRow({ ...FIELDS, id: "r-done", origin, status: "pending" }).startedBy;
    expect(started({ kind: "trigger", triggerId: "friday", eventId: 2 })).toEqual({
      source: "schedule",
      text: "friday",
    });
    expect(started({ kind: "manual", actor: "user" })).toEqual({ source: undefined, text: "You" });
    // The trigger is gone from the definition, so neither icon is drawn.
    expect(started({ kind: "trigger", triggerId: "nightly", eventId: 3 })).toEqual({
      source: undefined,
      text: "nightly",
    });
  });

  it("gives a pending run no duration, and ignores the sessions of a run that has ended", () => {
    expect(
      buildRow({ ...FIELDS, id: "r-pending", origin: BY_LABEL, status: "pending" }),
    ).toMatchObject({
      mark: "working",
      status: { text: "Starting", tone: "muted" },
      durationText: "",
    });
    expect(
      buildRow({
        ...FIELDS,
        id: "r-waiting",
        origin: BY_LABEL,
        status: "completed",
        startedAt: FIELDS.createdAt,
        finishedAt: "2026-09-29T09:20:00.000Z",
      }),
    ).toMatchObject({ mark: "done", status: { text: "Completed", tone: "muted" } });
  });
});

describe("describeRunRow", () => {
  it("names a run's status, who started it, when, and how long it took", () => {
    const done = {
      ...FIELDS,
      id: "r-done",
      origin: BY_LABEL,
      status: "completed",
      startedAt: FIELDS.createdAt,
      finishedAt: "2026-09-29T09:20:00.000Z",
    } as const;
    expect(describeRunRow(buildRow(done))).toBe("Completed, started by labeled, 09:12, took 8m 0s");
    const pending = { ...FIELDS, id: "r-pending", origin: BY_LABEL, status: "pending" } as const;
    expect(describeRunRow(buildRow(pending))).toBe("Starting, started by labeled, 09:12");
    const running = {
      ...FIELDS,
      id: "r-running",
      origin: BY_LABEL,
      status: "running",
      startedAt: FIELDS.createdAt,
    } as const;
    expect(describeRunRow(buildRow(running))).toBe(
      "Running, started by labeled, 09:12, running for 29m 0s",
    );
  });
});

describe("buildTriggerRows", () => {
  it("lists the triggers in the order the definition declares them, with what each does", () => {
    const rows = buildTriggerRows(RELEASE, true, [MERGED, FRIDAY, LABELED], "UTC", NOW);
    expect(
      rows.map((row) => [row.id, row.source, row.roleText, row.firesOnText, row.status.text]),
    ).toEqual([
      ["labeled", "event", "Starts a run", "github.issue.labeled", "On event"],
      ["friday", "schedule", "Starts a run", "Fridays at 14:00", "Next Fri 14:00"],
      ["merged", "event", "Resumes a run", "github.pr.merged", ""],
    ]);
  });

  it("puts a trigger's error before anything else, a signal's too", () => {
    const error = { state: "error", message: "No such Connection", at: AT } as const;
    const rows = buildTriggerRows(
      RELEASE,
      false,
      [
        { ...FRIDAY, status: "paused", health: error },
        { ...MERGED, health: error },
      ],
      "UTC",
      NOW,
    );
    expect(rows.map((row) => row.status)).toEqual([
      { text: "No such Connection", tone: "fail" },
      { text: "No such Connection", tone: "fail" },
    ]);
  });

  it("says a start trigger is paused, or off while its workflow is disabled", () => {
    expect(
      buildTriggerRows(RELEASE, true, [{ ...FRIDAY, status: "paused" }], "UTC", NOW)[0]?.status,
    ).toEqual({
      text: "Paused",
      tone: "muted",
    });
    expect(buildTriggerRows(RELEASE, false, [FRIDAY], "UTC", NOW)[0]?.status.text).toBe("Off");
  });

  it("gives a start trigger's switch its state, and a signal no switch", () => {
    const rows = buildTriggerRows(
      RELEASE,
      false,
      [{ ...FRIDAY, status: "paused" }, MERGED],
      "UTC",
      NOW,
    );
    expect(rows.map((row) => row.isActive)).toEqual([false, undefined]);
    expect(buildTriggerRows(RELEASE, false, [FRIDAY], "UTC", NOW)[0]?.isActive).toBe(true);
  });

  it("adds the scheduled times a trigger missed after when it next fires", () => {
    const missed = {
      ...FRIDAY,
      skippedTicks: { from: "2026-09-25T14:00:00.000Z", until: "2026-09-25T14:00:00.000Z" },
    };
    expect(buildTriggerRows(RELEASE, true, [missed], "UTC", NOW)[0]?.status.text).toMatch(
      /^Next Fri 14:00 · Missed the scheduled time /,
    );
  });
});

describe("buildInputRows", () => {
  it("describes each input's type, whether it is required, and its default as JSON", () => {
    expect(buildInputRows(RELEASE)).toEqual([
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
    ]);
  });

  it("returns no rows for a workflow that declares no inputs", () => {
    expect(buildInputRows({ name: "Bare", steps: RELEASE.steps })).toEqual([]);
  });
});
