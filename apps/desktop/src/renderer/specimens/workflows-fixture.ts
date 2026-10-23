/**
 * The records of the Workflows specimen (workflows.tsx): the 44 workflows of
 * the Bureau book's workflow list (docs/design/crew-bureau-2/desktop/
 * workflows.html), as the controller would return them at the specimen's
 * clock, Tuesday 29 September 2026, 09:41 UTC. `pnpm compare:bureau`
 * compares the list the app builds from them with the book's table.
 *
 * The records are the reads the list is built from, so the specimen goes
 * through the app's real row builder: the workflows, their triggers, each
 * workflow's strip of newest runs, the live runs, and the sessions of the
 * runs that wait on the user. Each workflow is written below as the book
 * writes its row, and the records are built from that:
 *
 * - the strip is the book's, one letter per run, oldest first: `d` a
 *   completed run, `f` a failed one, `r` a running one, `w` a running one
 *   whose session waits on the user, and `c` a cancelled one;
 * - the newest run was created at `lastRunAt`, and each older one a day
 *   before the run after it. Only the newest run's time shows;
 * - the start triggers give Starts on and Next: a schedule's next fire is
 *   set as the controller sets it, and the book's "Paused" is a workflow
 *   whose start triggers are all paused.
 *
 * Ship release is also the workflow the book opens, so it holds what the
 * open workflow reads as well:
 * - its source, the book's YAML, with its signal trigger and the Agents and
 *   workflow actions its steps name;
 * - its runs, written one by one as the book's Runs list draws them, newest
 *   first, rather than from its strip. The list's runs are the strip's
 *   newest thirteen, and the strip's seven older runs follow them, three
 *   days apart.
 */
import {
  ANY_CONNECTION,
  type Agent,
  type OpenRequest,
  type PluginDetail,
  type RunSummary,
  type Session,
  type Trigger,
  type TriggerKind,
  type TriggerOn,
  type Workflow,
  type WorkflowAction,
  type WorkflowSummary,
} from "@hercule/contract";
import { GITHUB_PLUGIN } from "./plugins-fixture";
import { CLAUDE_SONNET, SPECIMEN_RECORDS } from "./sidebar-fixture";

/** One trigger of a workflow, as the fixture writes it. */
interface FixtureTrigger {
  readonly triggerId: string;
  /** What the trigger does: start a run, or resume one. `start` when not given. */
  readonly kind?: TriggerKind;
  readonly on: TriggerOn;
  /** The schedule's next fire, an ISO instant. None for an event's trigger. */
  readonly nextFireAt?: string;
  readonly paused?: true;
  /** The message of the trigger's error, when it is in error. */
  readonly error?: string;
}

/** One run of a workflow, as the fixture writes it. */
interface FixtureRun {
  /** The run's letter in the strip. */
  readonly letter: string;
  /** When the run was created and started, an ISO instant. */
  readonly createdAt: string;
  /** The start trigger that started the run. None for a run the user started. */
  readonly triggerId?: string;
  /** How long an ended run took, in minutes. */
  readonly minutes?: number;
  /** Why a failed run failed, at the workflow's `failedStepId` unless `failedStepId` is given. */
  readonly failureReason?: "step-failed" | "iteration-limit" | "session-failed";
  readonly failedStepId?: string;
}

/** One workflow of the book's list, as the fixture writes it. */
interface FixtureWorkflow {
  readonly name: string;
  /** False for a workflow whose switch is off. */
  readonly enabled?: false;
  /** Its triggers: its start triggers, which the list shows, and its signal triggers. */
  readonly triggers: ReadonlyArray<FixtureTrigger>;
  /** The book's strip, one letter per run, oldest first. */
  readonly strip: string;
  /**
   * The runs, newest first, when the fixture writes each of them. Their
   * letters, oldest first, must spell the strip. Without them, the runs are
   * built from the strip.
   */
  readonly runs?: ReadonlyArray<FixtureRun>;
  /** When the newest run was created, an ISO instant. None when the strip is empty. */
  readonly lastRunAt?: string;
  /** The step a failed run failed at. */
  readonly failedStepId?: string;
  /** Where each running run is: the steps it runs, or the signal it waits on. */
  readonly live?: { readonly activeStepIds?: string[]; readonly awaitedSignalIds?: string[] };
  /** The step whose session waits on the user, and the command it asks to run. */
  readonly waiting?: { readonly stepId: string; readonly command: string };
}

/** Returns a start trigger that fires on events of `kind`, named `triggerId` or after the kind. */
const onEvent = (
  kind: string,
  triggerId = kind.replaceAll(".", "_"),
  over: Partial<FixtureTrigger> = {},
): FixtureTrigger => ({ triggerId, on: { kind }, ...over });

/** Returns a start trigger on the cron `schedule`, next firing at `nextFireAt` when one is given. */
const onSchedule = (
  schedule: string,
  nextFireAt?: string,
  over: Partial<FixtureTrigger> & { readonly timezone?: string } = {},
): FixtureTrigger => {
  const { timezone, ...rest } = over;
  return {
    triggerId: "schedule",
    on: timezone === undefined ? { schedule } : { schedule, timezone },
    ...(nextFireAt !== undefined && { nextFireAt }),
    ...rest,
  };
};

/** Returns the ISO instant of `time`, "HH:MM" in UTC, on `date`, "YYYY-MM-DD". */
const at = (date: string, time: string): string => `${date}T${time}:00.000Z`;

/** The specimen's day, a Tuesday. */
const TODAY = "2026-09-29";

/** Returns a run of Ship release that `release_issue` started at 10:00 on `date` and that completed in 1h 23m. */
const shipCompletedRun = (date: string): FixtureRun => ({
  letter: "d",
  createdAt: at(date, "10:00"),
  triggerId: "release_issue",
  minutes: 83,
});

/** The book's workflows, in the book's order, which is the list's: by group, then by name. */
const BOOK_WORKFLOWS: ReadonlyArray<FixtureWorkflow> = [
  // Needs you.
  {
    name: "Rotate prod keys",
    triggers: [onSchedule("0 8 * * 2", at("2026-10-06", "08:00"))],
    strip: "dddddddddddw",
    lastRunAt: at(TODAY, "08:00"),
    waiting: {
      stepId: "rotate",
      command: "aws iam delete-access-key --user-name deploy-bot --access-key-id AKIA4XQ7",
    },
  },
  {
    name: "Ship release",
    triggers: [
      {
        triggerId: "release_issue",
        on: {
          kind: "github.issue.labeled",
          connectionId: ANY_CONNECTION,
          filter: 'event.payload.label.name == "release"',
        },
      },
      onSchedule("0 14 * * 5", at("2026-10-02", "14:00"), { triggerId: "release_train" }),
      {
        triggerId: "pr_merged",
        kind: "signal",
        on: { kind: "github.pr.merged", connectionId: ANY_CONNECTION },
      },
    ],
    strip: "dddfdddddddfddddfcrw",
    runs: [
      { letter: "w", createdAt: at(TODAY, "09:12"), triggerId: "release_issue" },
      { letter: "r", createdAt: at("2026-09-28", "05:41") },
      { letter: "c", createdAt: at("2026-09-27", "11:20"), minutes: 3 },
      {
        letter: "f",
        createdAt: at("2026-09-25", "14:00"),
        triggerId: "release_train",
        minutes: 40,
        failureReason: "iteration-limit",
      },
      ...["09-22", "09-19", "09-16", "09-13"].map((day) => shipCompletedRun(`2026-${day}`)),
      {
        letter: "f",
        createdAt: at("2026-09-10", "10:00"),
        triggerId: "release_issue",
        minutes: 11,
        failureReason: "session-failed",
        failedStepId: "test",
      },
      ...["09-07", "09-04", "09-01", "08-29", "08-26", "08-23", "08-20"].map((day) =>
        shipCompletedRun(`2026-${day}`),
      ),
      {
        letter: "f",
        createdAt: at("2026-08-17", "10:00"),
        triggerId: "release_issue",
        minutes: 11,
        failureReason: "session-failed",
        failedStepId: "test",
      },
      ...["08-14", "08-11", "08-08"].map((day) => shipCompletedRun(`2026-${day}`)),
    ],
    lastRunAt: at(TODAY, "09:12"),
    failedStepId: "review",
    live: { awaitedSignalIds: ["pr_merged"] },
    waiting: { stepId: "security", command: "npm audit fix --force" },
  },
  // Failing.
  {
    name: "Label new issues",
    triggers: [onEvent("github.issue.opened", "issue_opened", { error: "No such key: labels" })],
    strip: "dddddddddddd",
    lastRunAt: at(TODAY, "06:21"),
  },
  {
    name: "Nightly backup check",
    triggers: [onSchedule("30 2 * * *", at("2026-09-30", "02:30"))],
    strip: "ddddddddddddddddddff",
    lastRunAt: at(TODAY, "02:30"),
    failedStepId: "compare",
  },
  {
    name: "Reload staging",
    triggers: [onEvent("github.pr.merged")],
    strip: "dddddddfdddddddddfdf",
    lastRunAt: at(TODAY, "09:18"),
    failedStepId: "smoke",
  },
  {
    name: "Watch flaky tests",
    triggers: [onEvent("run.failed")],
    strip: "dddddfdddf",
    lastRunAt: at(TODAY, "03:41"),
    failedStepId: "diagnose",
  },
  // Running.
  {
    name: "Fix bug",
    triggers: [onEvent("github.issue.labeled")],
    strip: "ddddfdddddddrdfdddr",
    lastRunAt: at(TODAY, "09:27"),
    failedStepId: "test",
    live: { activeStepIds: ["fix"] },
  },
  {
    name: "Investigate",
    triggers: [onEvent("github.issue.assigned")],
    strip: "dddddddr",
    lastRunAt: at(TODAY, "09:35"),
    live: { activeStepIds: ["investigate"] },
  },
  {
    name: "Review dependabot",
    triggers: [onEvent("github.pr.opened")],
    strip: "ddddddddddddddddddrr",
    lastRunAt: at(TODAY, "09:37"),
    live: { activeStepIds: ["review"] },
  },
  {
    name: "Translate docs",
    triggers: [onEvent("github.pr.merged")],
    strip: "dddddddr",
    lastRunAt: at(TODAY, "09:30"),
    live: { activeStepIds: ["translate"] },
  },
  // Everything else.
  {
    name: "Assign reviewers",
    triggers: [onEvent("github.pr.opened")],
    strip: "ddddddddddddddddddd",
    lastRunAt: at(TODAY, "08:53"),
  },
  {
    name: "Audit IAM roles",
    triggers: [onSchedule("0 7 1 * *", at("2026-10-01", "07:00"))],
    strip: "dddddd",
    lastRunAt: at("2026-09-01", "07:00"),
  },
  {
    name: "Bump dependencies",
    triggers: [onSchedule("0 6 * * 1", at("2026-10-05", "06:00"))],
    strip: "ddddddddfddd",
    lastRunAt: at("2026-09-28", "06:00"),
    failedStepId: "test",
  },
  {
    name: "Check closed issues",
    triggers: [onEvent("github.issue.closed")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "08:26"),
  },
  {
    name: "Check SSL expiry",
    triggers: [onSchedule("0 8 * * *", at("2026-09-30", "08:00"))],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "08:00"),
  },
  {
    name: "Clean preview envs",
    triggers: [onEvent("github.pr.closed")],
    strip: "dddddddddddcdddddddd",
    lastRunAt: at(TODAY, "06:29"),
  },
  {
    name: "Close stale PRs",
    triggers: [onSchedule("0 5 * * 1", at("2026-10-05", "05:00"))],
    strip: "dddddddd",
    lastRunAt: at("2026-09-28", "05:00"),
  },
  {
    name: "Close stale tasks",
    triggers: [onSchedule("0 4 * * 0", at("2026-10-04", "04:00"))],
    strip: "dddddddddd",
    lastRunAt: at("2026-09-27", "04:00"),
  },
  {
    name: "Compress screenshots",
    triggers: [onEvent("github.pr.synchronized")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "09:07"),
  },
  {
    name: "Copy edit blog",
    triggers: [onEvent("github.pr.opened")],
    strip: "ddddddd",
    lastRunAt: at("2026-09-26", "11:00"),
  },
  {
    name: "Draft changelog",
    triggers: [onEvent("github.pr.merged")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "09:19"),
  },
  {
    name: "Draft reply",
    triggers: [onEvent("github.issue.commented")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "09:32"),
  },
  {
    name: "Escalate stuck tasks",
    triggers: [onEvent("task.updated")],
    strip: "ddddd",
    lastRunAt: at("2026-09-27", "15:00"),
  },
  {
    name: "Explain failed runs",
    triggers: [onEvent("run.failed")],
    strip: "ddddddddddddd",
    lastRunAt: at(TODAY, "03:39"),
  },
  {
    name: "Lint docs",
    triggers: [onEvent("github.pr.opened")],
    strip: "ddddfdddd",
    lastRunAt: at("2026-09-28", "16:00"),
    failedStepId: "lint",
  },
  {
    name: "Merge approved PRs",
    triggers: [onEvent("github.pr.labeled")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "08:50"),
  },
  {
    name: "Nightly e2e",
    triggers: [onSchedule("0 1 * * *", at("2026-09-30", "01:00"))],
    strip: "dddddddddddddddfdddd",
    lastRunAt: at(TODAY, "01:00"),
    failedStepId: "e2e",
  },
  {
    name: "Notify on-call",
    triggers: [onEvent("run.failed")],
    strip: "ddddddddddddd",
    lastRunAt: at(TODAY, "03:38"),
  },
  {
    name: "Payout report",
    triggers: [onSchedule("0 7 1 * *", at("2026-10-01", "07:00"))],
    strip: "ddddd",
    lastRunAt: at("2026-09-01", "07:00"),
  },
  {
    name: "Plan sprint",
    triggers: [onSchedule("0 9 * * 1", at("2026-10-05", "09:00"))],
    strip: "ddddddd",
    lastRunAt: at("2026-09-28", "09:00"),
  },
  {
    name: "Post release notes",
    triggers: [onEvent("run.completed")],
    strip: "dddddddddd",
    lastRunAt: at("2026-09-23", "17:00"),
  },
  {
    name: "Prune branches",
    enabled: false,
    triggers: [onSchedule("0 3 * * 6")],
    strip: "",
  },
  {
    name: "Rebase open PRs",
    triggers: [onEvent("github.pr.merged")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "09:19"),
  },
  {
    name: "Refresh demo data",
    enabled: false,
    triggers: [onSchedule("0 6 * * 1")],
    strip: "ddfddd",
    lastRunAt: at("2026-08-17", "06:00"),
    failedStepId: "seed",
  },
  {
    name: "Respond to reviews",
    triggers: [onEvent("github.pr.commented")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "09:24"),
  },
  {
    name: "Retry cancelled runs",
    triggers: [onEvent("run.cancelled")],
    strip: "ddd",
    lastRunAt: at("2026-09-20", "12:00"),
  },
  {
    name: "Rotate secrets",
    enabled: false,
    triggers: [onSchedule("0 7 1 */3 *")],
    strip: "dd",
    lastRunAt: at("2026-07-01", "07:00"),
  },
  {
    name: "Scan for secrets",
    triggers: [onEvent("github.pr.synchronized")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "09:07"),
  },
  {
    name: "Summarize standup",
    triggers: [onSchedule("0 9 * * 1-5", at("2026-09-30", "08:00"), { timezone: "Europe/London" })],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "08:00"),
  },
  {
    name: "Sync translations",
    triggers: [onEvent("github.pr.labeled")],
    strip: "dddddddd",
    lastRunAt: at("2026-09-27", "10:00"),
  },
  {
    name: "Triage",
    triggers: [onEvent("github.issue.opened"), onEvent("github.issue.reopened")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "06:21"),
  },
  {
    name: "Triage new tasks",
    triggers: [onEvent("task.created")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "09:03"),
  },
  {
    name: "Weekly metrics",
    triggers: [onSchedule("0 8 * * 1", at("2026-10-05", "08:00"), { paused: true })],
    strip: "dddddddd",
    lastRunAt: at("2026-09-14", "08:00"),
  },
  {
    name: "Welcome contributors",
    triggers: [onEvent("github.pr.opened")],
    strip: "dfddddddddd",
    lastRunAt: at("2026-09-25", "13:00"),
    failedStepId: "greet",
  },
];

/** When every workflow and trigger was last changed. */
const UPDATED_AT = at("2026-09-01", "00:00");

/** Returns the id of record `number` of the kind `prefix` names, such as the workflows' `7800`. */
const buildId = (prefix: string, number: number): string =>
  `01a06d02-${prefix}-7000-8000-${String(number).padStart(12, "0")}`;

/** Returns the moment `days` days before `instant`, an ISO instant. */
const subtractDays = (instant: string, days: number): string =>
  new Date(Date.parse(instant) - days * 86_400_000).toISOString();

/** Returns the moment `minutes` minutes after `instant`, an ISO instant. */
const addMinutes = (instant: string, minutes: number): string =>
  new Date(Date.parse(instant) + minutes * 60_000).toISOString();

/**
 * Returns the runs of `workflow`, newest first: its `runs`, or else one run
 * per letter of its strip, the newest created at `lastRunAt` and each older
 * one a day before the run after it. Fails when its `runs` do not spell its
 * strip, because the workflow list draws the strip from them.
 */
const buildFixtureRuns = (workflow: FixtureWorkflow): ReadonlyArray<FixtureRun> => {
  if (workflow.runs !== undefined) {
    const strip = workflow.runs
      .map(({ letter }) => letter)
      .toReversed()
      .join("");
    if (strip !== workflow.strip) {
      throw new Error(
        `The runs of ${workflow.name} spell the strip "${strip}", not the book's "${workflow.strip}".`,
      );
    }
    return workflow.runs;
  }
  return [...workflow.strip].toReversed().map((letter, age) => ({
    letter,
    createdAt: subtractDays(workflow.lastRunAt ?? UPDATED_AT, age),
  }));
};

/** Returns the run `run` stands for, of `workflow`, with the fields every run shares in `fields`. */
const buildRun = (
  run: FixtureRun,
  fields: Pick<RunSummary, "id" | "workflowId" | "workflowName" | "origin" | "createdAt">,
  workflow: FixtureWorkflow,
): RunSummary => {
  const { createdAt } = fields;
  const finishedAt = addMinutes(createdAt, run.minutes ?? 5);
  switch (run.letter) {
    case "d":
      return { ...fields, status: "completed", startedAt: createdAt, finishedAt };
    case "f":
      return {
        ...fields,
        status: "failed",
        failureReason: run.failureReason ?? "step-failed",
        failedStepId: run.failedStepId ?? workflow.failedStepId ?? "run",
        startedAt: createdAt,
        finishedAt,
      };
    case "c":
      return { ...fields, status: "cancelled", startedAt: createdAt, finishedAt };
    case "r":
      return {
        ...fields,
        status: "running",
        startedAt: createdAt,
        activeStepIds: workflow.live?.activeStepIds ?? [],
        awaitedSignalIds: workflow.live?.awaitedSignalIds ?? [],
      };
    case "w":
      return {
        ...fields,
        status: "running",
        startedAt: createdAt,
        activeStepIds: [workflow.waiting?.stepId ?? "ask"],
        awaitedSignalIds: [],
      };
    default:
      throw new Error(`The fixture's strip has a letter "${run.letter}" that stands for no run.`);
  }
};

/**
 * Returns the session of `run`'s step `stepId`, waiting on the user to run
 * `command`. Like every session a run's agent step starts, it is of kind
 * `run` and has an Agent behind it; the fixture names the Writer for every
 * step.
 */
const buildWaitingSession = (
  number: number,
  run: RunSummary,
  stepId: string,
  command: string,
): Session => {
  const request: OpenRequest = {
    requestId: `r-${String(number)}`,
    itemId: `tool-${String(number)}`,
    decisions: ["allow", "deny"],
    kind: "command_approval",
    detail: { command },
  };
  return {
    ...SPECIMEN_RECORDS.threads[0]!,
    id: buildId("7a00", number),
    title: `${run.workflowName} · ${stepId}`,
    status: "busy",
    kind: "run",
    agentId: AGENTS[0]!.id,
    runId: run.id,
    stepId,
    openRequests: [request],
    lastActivityAt: run.createdAt,
  };
};

/** The source of Ship release, the book's YAML. */
const SHIP_RELEASE_SOURCE = `name: Ship release
description: Prepares a release in parallel, opens the release PR, and announces it once the PR is merged.
inputs:
  - name: version
    schema:
      type: string
    required: false
triggers:
  - id: release_issue
    kind: start
    on:
      kind: github.issue.labeled
      connectionId: any
      filter: event.payload.label.name == "release"
    inputs:
      version: event.payload.issue.title
  - id: release_train
    kind: start
    on:
      schedule: 0 14 * * 5
  - id: pr_merged
    kind: signal
    on:
      kind: github.pr.merged
      connectionId: any
    correlation:
      event: event.payload.number
      run: steps.open_pr.output.number
steps:
  - id: changelog
    kind: agent
    agent: 01a0ec64-6e80-7000-8000-a00000000001
    prompt: Write the changelog for {{ inputs.version }} from the merged pull requests.
  - id: security
    kind: agent
    agent: 01a0ec64-6e80-7000-8000-a00000000002
    prompt: Audit the dependencies and fix what you can.
  - id: test
    kind: agent
    agent: 01a0ec64-6e80-7000-8000-a00000000003
    prompt: Run the full test suite and the end-to-end tests.
  - id: review
    kind: agent
    agent: 01a0ec64-6e80-7000-8000-a00000000004
    prompt: Review the release diff. Answer approved or changes.
    outputSchema:
      type: object
      properties:
        verdict:
          enum: [approved, changes]
      required: [verdict]
    entry: true
  - id: fix
    kind: agent
    agent: 01a0ec64-6e80-7000-8000-a00000000005
    prompt: Make the changes the review asked for.
  - id: open_pr
    kind: action
    action: github/pr.create
    params:
      connection: any
      title: Release {{ inputs.version }}
      head: release/{{ inputs.version }}
      base: main
    join: all
  - id: announce
    kind: agent
    agent: 01a0ec64-6e80-7000-8000-a00000000001
    prompt: Write the release announcement from the changelog.
  - id: notify
    kind: action
    action: notification.create
    params:
      title: Released {{ inputs.version }}
    terminal: true
edges:
  - from: changelog
    to: open_pr
  - from: security
    to: open_pr
  - from: test
    to: open_pr
  - from: review
    to: open_pr
    condition: steps.review.output.verdict == "approved"
  - from: review
    to: fix
    condition: steps.review.output.verdict == "changes"
  - from: fix
    to: review
    maxTraversals: 3
  - from: pr_merged
    to: announce
  - from: announce
    to: notify`;

/** Returns the Agent `id`, named `name`, which a step of Ship release runs. */
const buildAgent = (id: string, name: string): Agent => ({
  id,
  name,
  systemPrompt: `You are ${name}.`,
  instanceId: CLAUDE_SONNET.instanceId,
  permissionProfileId: "01a0ec64-6e80-7000-8000-b00000000001",
  accessMode: "full-access",
  model: null,
  disallowedTools: [],
  unenforced: [],
  createdAt: UPDATED_AT,
  updatedAt: UPDATED_AT,
});

/** The Agents the steps of Ship release name, by the names the book gives them. */
const AGENTS: ReadonlyArray<Agent> = [
  buildAgent("01a0ec64-6e80-7000-8000-a00000000001", "Writer"),
  buildAgent("01a0ec64-6e80-7000-8000-a00000000002", "Auditor"),
  buildAgent("01a0ec64-6e80-7000-8000-a00000000003", "Tester"),
  buildAgent("01a0ec64-6e80-7000-8000-a00000000004", "Reviewer"),
  buildAgent("01a0ec64-6e80-7000-8000-a00000000005", "Coder"),
];

/** The workflow actions the steps of Ship release call, by the names the book gives them. */
const WORKFLOW_ACTIONS: ReadonlyArray<WorkflowAction> = [
  {
    id: "github/pr.create",
    displayName: "Open a GitHub pull request",
    description: "Opens a pull request.",
    runsIn: "controller",
    inputSchema: { type: "object" },
    connection: { type: "github/github" },
  },
  {
    id: "notification.create",
    displayName: "Send a notification",
    description: "Sends the user a notification.",
    runsIn: "controller",
    inputSchema: { type: "object" },
  },
];

/** The workflow the book opens, and what its page reads besides the list's reads. */
export interface OpenWorkflowRecords {
  /** The workflow, as `workflow.read` returns it. */
  readonly workflow: Workflow;
  /** Its runs, newest first, as `run.query({ workflowId })` lists them on one page. */
  readonly runs: ReadonlyArray<RunSummary>;
  /** Its runs that were live at some moment today, as the timeline reads them. */
  readonly todayRuns: {
    /** Today's start, an ISO instant, which the timeline reads the runs from. */
    readonly activeSince: string;
    /** Today's end, an ISO instant, which the timeline reads the runs until. */
    readonly until: string;
    readonly runs: ReadonlyArray<RunSummary>;
  };
  /** Every Agent, as `agent.query` lists them. */
  readonly agents: ReadonlyArray<Agent>;
  /** Every workflow action, as `workflowAction.query` lists them. */
  readonly workflowActions: ReadonlyArray<WorkflowAction>;
}

/** What the Workflows page reads, as the controller would return it. */
export interface WorkflowsRecords {
  /** Every workflow, as `workflow.query` lists them. */
  readonly workflows: ReadonlyArray<WorkflowSummary>;
  /** Every trigger of every workflow, as `trigger.query` lists them. */
  readonly triggers: ReadonlyArray<Trigger>;
  /**
   * Every workflow's newest runs, at most 20 per workflow, each workflow's
   * newest first, as `run.query({ newestPerWorkflow: 20 })` lists them.
   */
  readonly newestRuns: ReadonlyArray<RunSummary>;
  /** Every running run, as `run.query({ status: "running" })` lists them. None is pending. */
  readonly runningRuns: ReadonlyArray<RunSummary>;
  /** The live sessions that are not threads: one per run that waits on the user. */
  readonly agentSessions: ReadonlyArray<Session>;
  /**
   * The installed plugins, as `plugin.query` lists them: GitHub, whose mark
   * Ship release's open_pr step draws, because it calls `github/pr.create`.
   */
  readonly plugins: ReadonlyArray<PluginDetail>;
  /** Ship release, the workflow the book opens. */
  readonly openWorkflow: OpenWorkflowRecords;
}

/** The name of the workflow the book opens. */
const OPEN_WORKFLOW_NAME = "Ship release";

/** Checks whether `run` was live at some moment from `start` to `end`, two ISO instants. */
const isLiveBetween = (run: RunSummary, start: string, end: string): boolean =>
  Date.parse(run.createdAt) < Date.parse(end) &&
  (!("finishedAt" in run) || Date.parse(run.finishedAt) > Date.parse(start));

/** Builds the records from the book's workflows. */
const buildWorkflowsRecords = (): WorkflowsRecords => {
  const workflows: WorkflowSummary[] = [];
  const triggers: Trigger[] = [];
  const newestRuns: RunSummary[] = [];
  const runningRuns: RunSummary[] = [];
  const agentSessions: Session[] = [];
  let runNumber = 0;
  let openWorkflow: OpenWorkflowRecords | undefined;

  BOOK_WORKFLOWS.forEach((book, index) => {
    const workflow: WorkflowSummary = {
      id: buildId("7800", index + 1),
      name: book.name,
      enabled: book.enabled ?? true,
      updatedAt: UPDATED_AT,
    };
    workflows.push(workflow);
    for (const trigger of book.triggers) {
      const kind = trigger.kind ?? "start";
      triggers.push({
        workflowId: workflow.id,
        workflowName: workflow.name,
        triggerId: trigger.triggerId,
        kind,
        on: trigger.on,
        // Only a start trigger has a status and a health.
        ...(kind === "start" && {
          status: trigger.paused === true ? "paused" : "active",
          health:
            trigger.error === undefined
              ? { state: "ok" }
              : { state: "error", message: trigger.error, at: book.lastRunAt ?? UPDATED_AT },
        }),
        ...(trigger.nextFireAt !== undefined && { nextFireAt: trigger.nextFireAt }),
        createdAt: UPDATED_AT,
        updatedAt: UPDATED_AT,
      });
    }

    const runs = buildFixtureRuns(book).map((fixtureRun) => {
      runNumber += 1;
      const run = buildRun(
        fixtureRun,
        {
          id: buildId("7900", runNumber),
          workflowId: workflow.id,
          workflowName: workflow.name,
          origin:
            fixtureRun.triggerId === undefined
              ? { kind: "manual", actor: "user" }
              : { kind: "trigger", triggerId: fixtureRun.triggerId, eventId: runNumber },
          createdAt: fixtureRun.createdAt,
        },
        book,
      );
      if (run.status === "running") runningRuns.push(run);
      if (fixtureRun.letter === "w" && book.waiting !== undefined) {
        agentSessions.push(
          buildWaitingSession(runNumber, run, book.waiting.stepId, book.waiting.command),
        );
      }
      return run;
    });
    newestRuns.push(...runs);

    if (book.name === OPEN_WORKFLOW_NAME) {
      const activeSince = at(TODAY, "00:00");
      const until = at("2026-09-30", "00:00");
      openWorkflow = {
        workflow: {
          id: workflow.id,
          enabled: workflow.enabled,
          source: SHIP_RELEASE_SOURCE,
          createdAt: UPDATED_AT,
          updatedAt: UPDATED_AT,
        },
        runs,
        todayRuns: {
          activeSince,
          until,
          runs: runs.filter((run) => isLiveBetween(run, activeSince, until)),
        },
        agents: AGENTS,
        workflowActions: WORKFLOW_ACTIONS,
      };
    }
  });

  if (openWorkflow === undefined) {
    throw new Error(`The fixture has no workflow named ${OPEN_WORKFLOW_NAME} to open.`);
  }
  return {
    workflows,
    triggers,
    newestRuns,
    runningRuns,
    agentSessions,
    plugins: [GITHUB_PLUGIN],
    openWorkflow,
  };
};

export const WORKFLOWS_RECORDS: WorkflowsRecords = buildWorkflowsRecords();
