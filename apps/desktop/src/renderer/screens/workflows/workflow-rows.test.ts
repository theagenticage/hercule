import { describe, expect, it } from "vitest";
import { buildSession } from "@hercule/client-core/threads/testing";
import type { RunStatus, Trigger, TriggerOn } from "@hercule/contract";
import type { RecentRun, WorkflowListEntry } from "./proposed-contract";
import {
  buildWorkflowListItems,
  buildWorkflowRows,
  countWorkflowsByFilter,
  pickWorkflowFocusFallback,
  type WorkflowRow,
} from "./workflow-rows";

// Tuesday 29 September 2026, 09:41 UTC.
const NOW = new Date(Date.UTC(2026, 8, 29, 9, 41));
const AT = "2026-09-01T00:00:00.000Z";

/** Returns a recent run of `status` that started at `createdAt`. */
const buildRun = (
  id: string,
  status: RunStatus,
  createdAt: string,
  extra: Partial<RecentRun> = {},
): RecentRun => ({ id, status, waitingOnUser: false, createdAt, stepIds: [], ...extra });

/** Returns the workflow `id`, named `name`, with its newest-first `recentRuns`. */
const buildEntry = (
  id: string,
  name: string,
  recentRuns: ReadonlyArray<RecentRun>,
  enabled = true,
): WorkflowListEntry => ({ id, name, enabled, updatedAt: AT, recentRuns });

/** Returns trigger `triggerId` of workflow `workflowId`, firing on `on`. */
const buildTrigger = (
  workflowId: string,
  triggerId: string,
  kind: Trigger["kind"],
  on: TriggerOn,
  extra: Partial<Trigger> = {},
): Trigger => ({
  workflowId,
  workflowName: workflowId,
  triggerId,
  kind,
  on,
  ...(kind === "start" ? { status: "active", health: { state: "ok" } } : {}),
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

const WORKFLOWS = [
  // Two runs wait on the user; the older one's session is read.
  buildEntry("ship", "Ship", [
    buildRun("ship-3", "running", "2026-09-29T09:30:00.000Z", { waitingOnUser: true }),
    buildRun("ship-2", "running", "2026-09-29T09:00:00.000Z", {
      waitingOnUser: true,
      stepIds: ["security"],
    }),
    buildRun("ship-1", "completed", "2026-09-28T09:00:00.000Z"),
    buildRun("ship-0", "failed", "2026-09-27T09:00:00.000Z", { stepIds: ["review"] }),
    buildRun("ship-x", "cancelled", "2026-09-26T09:00:00.000Z"),
  ]),
  // Its newest run failed, so an older live run does not make it running.
  buildEntry("backup", "Backup", [
    buildRun("backup-2", "failed", "2026-09-29T02:30:00.000Z", { stepIds: ["compare"] }),
    buildRun("backup-1", "running", "2026-09-28T02:30:00.000Z", { stepIds: ["pr_merged"] }),
  ]),
  // Its runs complete, but its trigger is in error.
  buildEntry("label", "Label", [buildRun("label-1", "completed", "2026-09-29T08:00:00.000Z")]),
  buildEntry("fix", "Fix", [
    buildRun("fix-2", "running", "2026-09-29T09:30:00.000Z", { stepIds: ["fix"] }),
    buildRun("fix-1", "running", "2026-09-29T09:00:00.000Z", { stepIds: ["pr_merged"] }),
  ]),
  // A live run newer than its failed one makes it running: the newest run decides.
  buildEntry("deploy", "Deploy", [
    buildRun("deploy-2", "running", "2026-09-29T09:00:00.000Z", { stepIds: ["pr_merged"] }),
    buildRun("deploy-1", "failed", "2026-09-28T09:00:00.000Z", { stepIds: ["test"] }),
  ]),
  buildEntry("ssl", "SSL", [buildRun("ssl-1", "completed", "2026-09-29T08:00:00.000Z")]),
  buildEntry("bump", "Bump", [buildRun("bump-1", "completed", "2026-09-28T07:00:00.000Z")]),
  buildEntry("audit", "Audit", [buildRun("audit-1", "completed", "2026-09-01T07:00:00.000Z")]),
  buildEntry("standup", "Standup", []),
  buildEntry("prune", "Prune", [], false),
  buildEntry("weekly", "Weekly", []),
];

const TRIGGERS = [
  buildTrigger("ship", "labeled", "start", { kind: "github.issue.labeled" }),
  buildTrigger(
    "ship",
    "friday",
    "start",
    { schedule: "0 14 * * 5" },
    {
      nextFireAt: "2026-10-02T14:00:00.000Z",
    },
  ),
  buildTrigger(
    "label",
    "issue_opened",
    "start",
    { kind: "github.issue.opened" },
    {
      health: { state: "error", message: "No such key: labels", at: AT },
    },
  ),
  buildTrigger("fix", "assigned", "start", { kind: "github.issue.assigned" }),
  buildTrigger("fix", "pr_merged", "signal", { kind: "github.pr.merged" }),
  buildTrigger("deploy", "pr_merged", "signal", { kind: "github.pr.merged" }),
  buildTrigger(
    "ssl",
    "daily",
    "start",
    { schedule: "0 8 * * *" },
    {
      nextFireAt: "2026-09-30T08:00:00.000Z",
    },
  ),
  buildTrigger(
    "bump",
    "tuesdays",
    "start",
    { schedule: "0 7 * * 2" },
    {
      nextFireAt: "2026-10-06T07:00:00.000Z",
    },
  ),
  buildTrigger(
    "audit",
    "monthly",
    "start",
    { schedule: "0 7 1 * *" },
    {
      nextFireAt: "2026-10-01T07:00:00.000Z",
    },
  ),
  buildTrigger("standup", "weekdays", "start", {
    schedule: "0 9 * * 1-5",
    timezone: "Europe/London",
  }),
  buildTrigger("prune", "nightly", "start", { schedule: "0 3 * * *" }),
  buildTrigger("weekly", "mondays", "start", { schedule: "0 8 * * 1" }, { status: "paused" }),
];

const SESSIONS = [
  buildSession({
    id: "s-security",
    runId: "ship-2",
    stepId: "security",
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

const rows = buildWorkflowRows(WORKFLOWS, TRIGGERS, SESSIONS, "UTC", NOW);

/** Returns the row of the workflow named `name`. */
const findRow = (name: string): WorkflowRow => rows.find((row) => row.name === name)!;

describe("buildWorkflowRows", () => {
  it("lists the workflows that need a look first, by group, each group by name", () => {
    expect(rows.map((row) => [row.group, row.mark, row.name])).toEqual([
      ["needsYou", "waiting", "Ship"],
      ["failing", "failed", "Backup"],
      ["failing", "failed", "Label"],
      ["running", "working", "Deploy"],
      ["running", "working", "Fix"],
      ["rest", "idle", "Audit"],
      ["rest", "idle", "Bump"],
      ["rest", "paused", "Prune"],
      ["rest", "idle", "SSL"],
      ["rest", "idle", "Standup"],
      ["rest", "paused", "Weekly"],
    ]);
  });

  it("names the step of the run waiting longest, and what it asks", () => {
    expect(findRow("Ship").status).toEqual({
      text: "security asks: Run npm audit fix --force?",
      tone: "you",
    });
  });

  it("says where a failing workflow failed: at a step, or at a start trigger in error", () => {
    expect(findRow("Backup").status).toEqual({ text: "Failed at compare", tone: "fail" });
    expect(findRow("Label")).toMatchObject({
      successText: "100%",
      status: { text: "issue_opened: No such key: labels", tone: "fail" },
    });
  });

  it("says where the live runs are, and which signal a run waits on", () => {
    expect(findRow("Deploy").status).toEqual({ text: "Waiting on pr_merged", tone: "muted" });
    expect(findRow("Fix").status.text).toBe("2 runs · at fix, waiting on pr_merged");
  });

  it("draws the recent runs oldest first, and counts only those that completed or failed", () => {
    const { strip, successText } = findRow("Ship");
    expect(strip.map((run) => run.mark)).toEqual(["idle", "failed", "done", "waiting", "waiting"]);
    expect(successText).toBe("50%");
  });

  it("dates the latest run by its clock time today, its weekday this week, and its date before", () => {
    expect(findRow("SSL").timeText).toBe("08:00");
    expect(findRow("Bump").timeText).toBe("Mon");
    expect(findRow("Audit").timeText).toBe("1 Sep");
  });

  it("says when each workflow next starts a run", () => {
    expect(findRow("SSL").nextText).toBe("Wed 08:00");
    expect(findRow("Audit").nextText).toBe("Thu 07:00");
    // A week from today is past the weekdays, so it shows its date.
    expect(findRow("Bump").nextText).toBe("6 Oct");
    expect(findRow("Ship").nextText).toBe("Fri 14:00");
    expect(findRow("Fix").nextText).toBe("On event");
    // The scheduler has not read the trigger yet.
    expect(findRow("Standup").nextText).toBe("");
  });

  it("says a workflow with no start trigger starts on demand", () => {
    expect(findRow("Deploy")).toMatchObject({ startsOn: undefined, nextText: "On demand" });
  });

  it("marks a workflow off when it is disabled or every start trigger is paused", () => {
    expect(rows.filter((row) => row.isOff).map((row) => [row.name, row.nextText])).toEqual([
      ["Prune", "Off"],
      ["Weekly", "Paused"],
    ]);
    expect(findRow("Prune")).toMatchObject({
      status: { text: "No runs yet" },
      successText: "",
      timeText: "",
      strip: [],
    });
  });

  it("describes what starts each workflow, in words where it can", () => {
    expect(findRow("Ship").startsOn).toEqual({
      firesOnSchedule: false,
      text: "github.issue.labeled · Fridays at 14:00",
    });
    expect(findRow("Standup").startsOn).toEqual({
      firesOnSchedule: true,
      text: "Weekdays at 09:00 (Europe/London)",
    });
  });
});

describe("buildWorkflowListItems", () => {
  /** Returns each item's group key or workflow name. */
  const readItems = (filter: Parameters<typeof buildWorkflowListItems>[1], search: string) =>
    buildWorkflowListItems(rows, filter, search).map((item) =>
      item.kind === "group-header" ? item.group : item.row.name,
    );

  it("puts each group's header, with its count, before its rows", () => {
    const items = buildWorkflowListItems(rows, "all", "");
    expect(items).toHaveLength(rows.length + 4);
    expect(items[0]).toEqual({
      kind: "group-header",
      key: "group:needsYou",
      group: "needsYou",
      title: "Needs you",
      count: 1,
    });
    expect(items[1]?.key).toBe("workflow:ship");
    expect(items[2]).toMatchObject({ key: "group:failing", title: "Failing", count: 2 });
  });

  it("keeps the rows that pass the filter, and drops the headers of empty groups", () => {
    expect(readItems("off", "")).toEqual(["rest", "Prune", "Weekly"]);
    expect(readItems("failing", "")).toEqual(["failing", "Backup", "Label"]);
  });

  it("counts the rows each filter keeps, an off workflow in its group too", () => {
    expect(countWorkflowsByFilter(rows)).toEqual({
      all: 11,
      needsYou: 1,
      failing: 2,
      running: 2,
      off: 2,
    });
  });

  it("keeps the rows that hold every word of the search, in any case, trigger ids included", () => {
    expect(readItems("all", "  FIX  ASSIGNED ")).toEqual(["running", "Fix"]);
    expect(readItems("all", "pr_merged")).toEqual(["running", "Deploy", "Fix"]);
    expect(readItems("running", "London")).toEqual([]);
  });
});

describe("pickWorkflowFocusFallback", () => {
  const all = buildWorkflowListItems(rows, "all", "");

  it("moves focus from a row a filter hides to its group's header", () => {
    const failing = buildWorkflowListItems(rows, "failing", "");
    // Fix is running, so the filter hides it, and its header with it.
    expect(pickWorkflowFocusFallback("workflow:backup", all, failing)).toBe("group:failing");
    expect(pickWorkflowFocusFallback("workflow:fix", all, failing)).toBe("workflow:label");
  });

  it("moves focus to the last item when the list is now shorter, and nowhere when it is empty", () => {
    const off = buildWorkflowListItems(rows, "off", "");
    expect(pickWorkflowFocusFallback("workflow:label", all, off)).toBe("workflow:weekly");
    expect(pickWorkflowFocusFallback("workflow:ship", all, [])).toBeNull();
  });
});
