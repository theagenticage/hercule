/**
 * Tests the workflow list's rows, groups, filters, search and focus fallback,
 * built from the reads the desktop app's workflow list makes.
 */
import { assert, describe, it } from "vitest";
import type { OpenRequest, RunSummary, Session, Trigger, TriggerOn } from "@hercule/contract";
import { buildSession } from "./threads/workspaces.testing";
import {
  buildWorkflowListItems,
  buildWorkflowRows,
  countWorkflowsByFilter,
  pickWorkflowFocusFallback,
  type WorkflowListReads,
  type WorkflowRow,
} from "./workflow-rows";

const AT = "2026-09-01T00:00:00.000Z";

/** Returns the instant `minutes` minutes after 09:00 UTC on 29 September 2026. */
const at = (minutes: number): string =>
  new Date(Date.UTC(2026, 8, 29, 9, 0) + minutes * 60_000).toISOString();

const summaryFields = (id: string, workflowId: string, createdAt: string) => ({
  id,
  workflowId,
  workflowName: workflowId,
  origin: { kind: "manual" as const, actor: "user" },
  createdAt,
});

/** Returns a run of `workflowId`, created `minutes` after 09:00, in the state `status` names. */
const buildRun = (
  id: string,
  workflowId: string,
  minutes: number,
  status:
    | { readonly status: "pending" }
    | {
        readonly status: "running";
        readonly activeStepIds?: ReadonlyArray<string>;
        readonly awaitedSignalIds?: ReadonlyArray<string>;
      }
    | { readonly status: "completed" }
    | { readonly status: "failed"; readonly failedStepId?: string }
    | { readonly status: "cancelled" },
): RunSummary => {
  const fields = summaryFields(id, workflowId, at(minutes));
  switch (status.status) {
    case "pending":
      return { ...fields, status: "pending" };
    case "running":
      return {
        ...fields,
        status: "running",
        startedAt: fields.createdAt,
        activeStepIds: status.activeStepIds ?? [],
        awaitedSignalIds: status.awaitedSignalIds ?? [],
      };
    case "completed":
      return {
        ...fields,
        status: "completed",
        startedAt: fields.createdAt,
        finishedAt: at(minutes + 1),
      };
    case "failed":
      return status.failedStepId === undefined
        ? {
            ...fields,
            status: "failed",
            failureReason: "controller-error",
            finishedAt: at(minutes + 1),
          }
        : {
            ...fields,
            status: "failed",
            failureReason: "step-failed",
            failedStepId: status.failedStepId,
            startedAt: fields.createdAt,
            finishedAt: at(minutes + 1),
          };
    case "cancelled":
      return { ...fields, status: "cancelled", finishedAt: at(minutes + 1) };
  }
};

/** Returns trigger `triggerId` of `workflowId`, firing on `on`. */
const buildTrigger = (
  workflowId: string,
  triggerId: string,
  on: TriggerOn,
  over: Partial<Trigger> = {},
): Trigger => ({
  workflowId,
  workflowName: workflowId,
  triggerId,
  kind: "start",
  on,
  status: "active",
  health: { state: "ok" },
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

/** Returns a command approval asking to run `command`. */
const buildRequest = (requestId: string, command: string): OpenRequest => ({
  requestId,
  itemId: "tool-1",
  decisions: ["allow", "deny"],
  kind: "command_approval",
  detail: { command },
});

/** Returns the session of step `stepId` of run `runId`, waiting on the user to approve `command`. */
const buildWaitingSession = (
  id: string,
  runId: string,
  stepId: string | null,
  command: string,
  lastActivityAt = AT,
): Session =>
  buildSession({
    id,
    runId,
    stepId,
    agentId: "a-1",
    lastActivityAt,
    openRequests: [buildRequest(`${id}-r`, command)],
  });

/** Returns the reads of the list, with nothing in them but what `over` sets. */
const buildReads = (over: Partial<WorkflowListReads>): WorkflowListReads => ({
  workflows: [],
  triggers: [],
  strips: new Map(),
  liveRuns: [],
  sessions: [],
  ...over,
});

/** Returns a workflow called `name`, whose id is its name in lower case. */
const buildWorkflow = (name: string, over: { enabled?: boolean; description?: string } = {}) => ({
  id: name.toLowerCase(),
  name,
  enabled: over.enabled ?? true,
  updatedAt: AT,
  ...(over.description === undefined ? {} : { description: over.description }),
});

/** Returns the one row built for workflow `name` from `over`. */
const buildOneRow = (
  name: string,
  over: Partial<WorkflowListReads>,
  enabled = true,
): WorkflowRow => {
  const [row] = buildWorkflowRows(
    buildReads({ workflows: [buildWorkflow(name, { enabled })], ...over }),
  );
  assert.isDefined(row);
  return row;
};

describe("buildWorkflowRows groups", () => {
  it("puts a workflow whose live run has a session waiting on the user in Needs you", () => {
    const run = buildRun("r1", "ship", 0, { status: "running", activeStepIds: ["review"] });
    const row = buildOneRow("Ship", {
      strips: new Map([["ship", [run]]]),
      liveRuns: [run],
      sessions: [buildWaitingSession("s1", "r1", "review", "git push")],
    });

    assert.strictEqual(row.group, "needsYou");
    assert.strictEqual(row.mark, "waiting");
    assert.strictEqual(row.statusText, "review asks: Run git push?");
    assert.strictEqual(row.statusTone, "you");
    assert.deepStrictEqual(row.strip, ["waiting"]);
  });

  it("shows the question of the session that has waited longest", () => {
    const first = buildRun("r1", "ship", 0, { status: "running" });
    const second = buildRun("r2", "ship", 5, { status: "running" });
    const row = buildOneRow("Ship", {
      liveRuns: [second, first],
      sessions: [
        buildWaitingSession("s2", "r2", "deploy", "kubectl apply", at(6)),
        buildWaitingSession("s1", "r1", "review", "git push", at(1)),
      ],
    });

    assert.strictEqual(row.statusText, "review asks: Run git push?");
  });

  it("reads Waiting on you for a waiting session that is no step's", () => {
    const run = buildRun("r1", "ship", 0, { status: "running" });
    const row = buildOneRow("Ship", {
      liveRuns: [run],
      sessions: [buildWaitingSession("s1", "r1", null, "git push")],
    });

    assert.strictEqual(row.statusText, "Waiting on you");
  });

  it("ignores a session with no open Request, and a session of no run", () => {
    const run = buildRun("r1", "ship", 0, { status: "running", activeStepIds: ["review"] });
    const row = buildOneRow("Ship", {
      liveRuns: [run],
      sessions: [
        buildSession({ id: "s1", runId: "r1", stepId: "review" }),
        buildSession({ id: "s2", openRequests: [buildRequest("r", "git push")] }),
      ],
    });

    assert.strictEqual(row.group, "running");
  });

  it("puts a workflow whose newest run failed in Failing, though an older run is live", () => {
    const live = buildRun("r1", "backup", 0, { status: "running", activeStepIds: ["copy"] });
    const failed = buildRun("r2", "backup", 10, { status: "failed", failedStepId: "compare" });
    const row = buildOneRow("Backup", {
      strips: new Map([["backup", [failed, live]]]),
      liveRuns: [live],
    });

    assert.strictEqual(row.group, "failing");
    assert.strictEqual(row.mark, "failed");
    assert.strictEqual(row.statusText, "Failed at compare");
    assert.strictEqual(row.statusTone, "fail");
  });

  it("puts a workflow whose newest run is live in Running, though the run before it failed", () => {
    const failed = buildRun("r1", "ship", 0, { status: "failed", failedStepId: "test" });
    const live = buildRun("r2", "ship", 10, { status: "running", activeStepIds: ["review"] });
    const row = buildOneRow("Ship", {
      strips: new Map([["ship", [live, failed]]]),
      liveRuns: [live],
    });

    assert.strictEqual(row.group, "running");
    assert.strictEqual(row.mark, "working");
    assert.strictEqual(row.statusText, "At review");
    assert.strictEqual(row.statusTone, "muted");
  });

  it("counts a live run that started after the strip was read as the newest run", () => {
    const failed = buildRun("r1", "ship", 0, { status: "failed" });
    const live = buildRun("r2", "ship", 10, { status: "pending" });
    const row = buildOneRow("Ship", { strips: new Map([["ship", [failed]]]), liveRuns: [live] });

    assert.strictEqual(row.group, "running");
    assert.strictEqual(row.lastRunAt, at(10));
  });

  it("puts a workflow with a live run older than its 20 newest runs in Running", () => {
    const old = buildRun("old", "nightly", 0, {
      status: "running",
      awaitedSignalIds: ["approved"],
    });
    const strip = Array.from({ length: 20 }, (_, index) =>
      buildRun(`r${String(index)}`, "nightly", 100 - index, { status: "completed" }),
    );
    const row = buildOneRow("Nightly", { strips: new Map([["nightly", strip]]), liveRuns: [old] });

    assert.strictEqual(row.group, "running");
    assert.strictEqual(row.statusText, "Waiting for approved");
  });

  it("puts a workflow whose only live run is pending in Running, as Starting", () => {
    const pending = buildRun("r1", "ship", 0, { status: "pending" });
    const row = buildOneRow("Ship", {
      strips: new Map([["ship", [pending]]]),
      liveRuns: [pending],
    });

    assert.strictEqual(row.group, "running");
    assert.strictEqual(row.statusText, "Starting");
    assert.deepStrictEqual(row.strip, ["starting"]);
  });

  it("reads a running run with no step started yet as Starting", () => {
    const run = buildRun("r1", "ship", 0, { status: "running" });
    const row = buildOneRow("Ship", { strips: new Map([["ship", [run]]]), liveRuns: [run] });

    assert.strictEqual(row.statusText, "Starting");
    assert.deepStrictEqual(row.strip, ["starting"]);
  });

  it("counts several live runs and lists where each is, once", () => {
    const row = buildOneRow("Fix", {
      liveRuns: [
        buildRun("r1", "fix", 0, { status: "running", activeStepIds: ["fix"] }),
        buildRun("r2", "fix", 5, { status: "running", awaitedSignalIds: ["pr_merged"] }),
        buildRun("r3", "fix", 9, { status: "running", activeStepIds: ["fix"] }),
      ],
    });

    assert.strictEqual(row.statusText, "3 runs · at fix, waiting for pr_merged");
  });

  it("puts a workflow with a start trigger in error in Failing, naming the trigger and its error", () => {
    const run = buildRun("r1", "label", 0, { status: "running", activeStepIds: ["label"] });
    const row = buildOneRow("Label", {
      triggers: [
        buildTrigger(
          "label",
          "on_issue",
          { kind: "github.issue.opened" },
          { health: { state: "error", message: "No such key: labels", at: AT } },
        ),
      ],
      strips: new Map([["label", [run]]]),
      liveRuns: [run],
    });

    assert.strictEqual(row.group, "failing");
    assert.strictEqual(row.statusText, "on_issue: No such key: labels");
    assert.strictEqual(row.statusTone, "fail");
  });

  it("puts every other workflow in Everything else, idle, with its last run's end", () => {
    const cases: ReadonlyArray<readonly [ReadonlyArray<RunSummary>, string]> = [
      [[buildRun("r1", "ssl", 0, { status: "completed" })], "Done"],
      [[buildRun("r1", "ssl", 0, { status: "cancelled" })], "Cancelled"],
      [[], "No runs yet"],
    ];
    for (const [strip, statusText] of cases) {
      const row = buildOneRow("SSL", { strips: new Map([["ssl", strip]]) });
      assert.strictEqual(row.group, "everythingElse");
      assert.strictEqual(row.mark, "idle");
      assert.strictEqual(row.statusText, statusText);
      assert.strictEqual(row.statusTone, "muted");
    }
  });

  it("reads Failed for a failed run that names no step", () => {
    const row = buildOneRow("SSL", {
      strips: new Map([["ssl", [buildRun("r1", "ssl", 0, { status: "failed" })]]]),
    });

    assert.strictEqual(row.statusText, "Failed");
  });
});

describe("buildWorkflowRows off and Next", () => {
  const SCHEDULE = { schedule: "0 14 * * 5" };

  it("marks a workflow whose switch is off as off, paused, with Next Off", () => {
    const row = buildOneRow(
      "Prune",
      { triggers: [buildTrigger("prune", "nightly", SCHEDULE)] },
      false,
    );

    assert.isTrue(row.isOff);
    assert.strictEqual(row.mark, "paused");
    assert.strictEqual(row.nextText, "Off");
    assert.isNull(row.nextFireAt);
  });

  it("marks a workflow whose every start trigger is paused as off, with Next Paused", () => {
    const row = buildOneRow("Weekly", {
      triggers: [buildTrigger("weekly", "mondays", SCHEDULE, { status: "paused" })],
    });

    assert.isTrue(row.isOff);
    assert.strictEqual(row.nextText, "Paused");
  });

  it("keeps its group's mark for a workflow that is off but in another group", () => {
    const row = buildOneRow(
      "Prune",
      { strips: new Map([["prune", [buildRun("r1", "prune", 0, { status: "failed" })]]]) },
      false,
    );

    assert.isTrue(row.isOff);
    assert.strictEqual(row.mark, "failed");
  });

  it("reads On demand for a workflow with no start trigger, which is never off for that", () => {
    const row = buildOneRow("Deploy", {
      triggers: [
        buildTrigger("deploy", "approved", { kind: "approval.given" }, { kind: "signal" }),
      ],
    });

    assert.isFalse(row.isOff);
    assert.strictEqual(row.startsOnText, "On demand");
    assert.isNull(row.startsOnFiresOn);
    assert.strictEqual(row.nextText, "On demand");
  });

  it("gives the soonest next fire of the active start triggers as an instant", () => {
    const row = buildOneRow("Ship", {
      triggers: [
        buildTrigger("ship", "friday", SCHEDULE, { nextFireAt: "2026-10-02T14:00:00.000Z" }),
        buildTrigger(
          "ship",
          "daily",
          { schedule: "0 8 * * *" },
          { nextFireAt: "2026-09-30T08:00:00.000Z" },
        ),
        buildTrigger(
          "ship",
          "hourly",
          { schedule: "5 * * * *" },
          { status: "paused", nextFireAt: "2026-09-29T10:05:00.000Z" },
        ),
      ],
    });

    assert.strictEqual(row.nextFireAt, "2026-09-30T08:00:00.000Z");
    assert.strictEqual(row.nextText, "");
  });

  it("reads On event when no active start trigger has a next fire and one fires on events", () => {
    const row = buildOneRow("Label", {
      triggers: [buildTrigger("label", "on_issue", { kind: "github.issue.opened" })],
    });

    assert.strictEqual(row.nextText, "On event");
    assert.isNull(row.nextFireAt);
  });
});

describe("buildWorkflowRows Starts on, the strip and Success", () => {
  it("names each start trigger, schedules in words with their own time zone, events by kind", () => {
    const row = buildOneRow("Ship", {
      triggers: [
        buildTrigger("ship", "labeled", { kind: "github.issue.labeled" }),
        buildTrigger("ship", "friday", { schedule: "0 14 * * 5", timezone: "Europe/Amsterdam" }),
        buildTrigger("ship", "approved", { kind: "approval.given" }, { kind: "signal" }),
      ],
    });

    assert.strictEqual(
      row.startsOnText,
      "github.issue.labeled · Fridays at 14:00 (Europe/Amsterdam)",
    );
    assert.strictEqual(row.startsOnFiresOn, "event");
    assert.isFalse(row.startsOnIsCode);
  });

  it("shows a schedule with no words as its cron expression, as code", () => {
    const row = buildOneRow("Rotate", {
      triggers: [buildTrigger("rotate", "quarterly", { schedule: "0 7 1 */3 *" })],
    });

    assert.strictEqual(row.startsOnText, "0 7 1 */3 *");
    assert.strictEqual(row.startsOnFiresOn, "schedule");
    assert.isTrue(row.startsOnIsCode);
  });

  it("draws the strip oldest first, a cancelled run with no mark", () => {
    const row = buildOneRow("Ship", {
      strips: new Map([
        [
          "ship",
          [
            buildRun("r4", "ship", 40, { status: "running", activeStepIds: ["review"] }),
            buildRun("r3", "ship", 30, { status: "cancelled" }),
            buildRun("r2", "ship", 20, { status: "failed" }),
            buildRun("r1", "ship", 10, { status: "completed" }),
          ],
        ],
      ]),
    });

    assert.deepStrictEqual(row.strip, ["done", "failed", "cancelled", "working"]);
  });

  it("gives completed runs out of completed and failed ones as a percentage", () => {
    const strip = [
      ...Array.from({ length: 11 }, (_, index) =>
        buildRun(`c${String(index)}`, "ship", index, { status: "completed" }),
      ),
      buildRun("f1", "ship", 20, { status: "failed" }),
      buildRun("f2", "ship", 21, { status: "failed" }),
      buildRun("x1", "ship", 22, { status: "cancelled" }),
    ].toReversed();
    const row = buildOneRow("Ship", { strips: new Map([["ship", strip]]) });

    assert.strictEqual(row.successText, "85%");
  });

  it("leaves Success empty when no run completed or failed", () => {
    const row = buildOneRow("Ship", {
      strips: new Map([["ship", [buildRun("x1", "ship", 0, { status: "cancelled" })]]]),
    });

    assert.strictEqual(row.successText, "");
  });

  it("builds equal rows from equal reads, so a screen redraws no row that did not change", () => {
    const run = buildRun("r1", "ship", 0, { status: "completed" });
    const reads = buildReads({
      workflows: [buildWorkflow("Ship")],
      strips: new Map([["ship", [run]]]),
    });

    assert.deepStrictEqual(buildWorkflowRows(reads), buildWorkflowRows(reads));
  });
});

/** The reads of a list with one workflow in each group, and two that are off. */
const LIST_READS = (() => {
  const waiting = buildRun("w1", "ship", 0, { status: "running" });
  const live = buildRun("l1", "fix", 0, { status: "running", activeStepIds: ["fix"] });
  return buildReads({
    workflows: [
      buildWorkflow("Ship"),
      buildWorkflow("Backup", { description: "Copies the database offsite" }),
      buildWorkflow("Fix"),
      buildWorkflow("Audit"),
      buildWorkflow("Prune", { enabled: false }),
      buildWorkflow("Archive", { enabled: false }),
    ],
    triggers: [buildTrigger("audit", "monthly_audit", { schedule: "0 7 1 * *" })],
    strips: new Map([["backup", [buildRun("f1", "backup", 0, { status: "failed" })]]]),
    liveRuns: [waiting, live],
    sessions: [buildWaitingSession("s1", "w1", "review", "git push")],
  });
})();

describe("buildWorkflowRows order", () => {
  it("sorts the rows by group, then by name", () => {
    assert.deepStrictEqual(
      buildWorkflowRows(LIST_READS).map((row) => row.name),
      ["Ship", "Backup", "Fix", "Archive", "Audit", "Prune"],
    );
  });
});

describe("countWorkflowsByFilter", () => {
  it("counts each filter's rows, Off from every group", () => {
    assert.deepStrictEqual(countWorkflowsByFilter(buildWorkflowRows(LIST_READS)), {
      all: 6,
      needsYou: 1,
      failing: 1,
      running: 1,
      off: 2,
    });
  });
});

describe("buildWorkflowListItems", () => {
  const rows = buildWorkflowRows(LIST_READS);

  it("leads each group's rows with its heading and count, and gives no heading to an empty group", () => {
    const items = buildWorkflowListItems(rows, "all", "");

    assert.deepStrictEqual(
      items.map((item) =>
        item.kind === "group-header" ? `${item.title} ${String(item.count)}` : item.row.name,
      ),
      [
        "Needs you 1",
        "Ship",
        "Failing 1",
        "Backup",
        "Running 1",
        "Fix",
        "Everything else 3",
        "Archive",
        "Audit",
        "Prune",
      ],
    );
    assert.strictEqual(new Set(items.map((item) => item.key)).size, items.length);
  });

  it("keeps only the rows the filter keeps", () => {
    const items = buildWorkflowListItems(rows, "off", "");

    assert.deepStrictEqual(
      items.map((item) => (item.kind === "group-header" ? item.title : item.row.name)),
      ["Everything else", "Archive", "Prune"],
    );
  });

  it("finds every word of the search, ignoring case, in the name, description, Starts on or a trigger id", () => {
    const names = (search: string): ReadonlyArray<string> =>
      buildWorkflowListItems(rows, "all", search).flatMap((item) =>
        item.kind === "workflow-row" ? [item.row.name] : [],
      );

    assert.deepStrictEqual(names("SHIP"), ["Ship"]);
    assert.deepStrictEqual(names("database offsite"), ["Backup"]);
    assert.deepStrictEqual(names("monthly on"), ["Audit"]);
    assert.deepStrictEqual(names("monthly_audit"), ["Audit"]);
    assert.deepStrictEqual(names("database ship"), []);
  });
});

describe("pickWorkflowFocusFallback", () => {
  const rows = buildWorkflowRows(LIST_READS);
  const all = buildWorkflowListItems(rows, "all", "");

  it("moves focus to the heading of the group a hidden row was in", () => {
    const after = buildWorkflowListItems(rows, "all", "audit");

    assert.strictEqual(
      pickWorkflowFocusFallback("workflow:archive", all, after),
      "group:everythingElse",
    );
  });

  it("moves focus to the entry now in the gone entry's place when its group is gone", () => {
    const after = buildWorkflowListItems(rows, "off", "");

    assert.strictEqual(pickWorkflowFocusFallback("workflow:ship", all, after), "workflow:archive");
  });

  it("returns null when the list is now empty", () => {
    assert.isNull(pickWorkflowFocusFallback("workflow:ship", all, []));
  });
});
