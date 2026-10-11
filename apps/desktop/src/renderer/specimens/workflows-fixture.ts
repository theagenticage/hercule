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
 */
import type {
  OpenRequest,
  RunSummary,
  Session,
  Trigger,
  TriggerOn,
  WorkflowSummary,
} from "@hercule/contract";
import { SPECIMEN_RECORDS } from "./sidebar-fixture";

/** One start trigger of a workflow, as the fixture writes it. */
interface FixtureTrigger {
  readonly triggerId: string;
  readonly on: TriggerOn;
  /** The schedule's next fire, an ISO instant. None for an event's trigger. */
  readonly nextFireAt?: string;
  readonly paused?: true;
  /** The message of the trigger's error, when it is in error. */
  readonly error?: string;
}

/** One workflow of the book's list, as the fixture writes it. */
interface FixtureWorkflow {
  readonly name: string;
  /** False for a workflow whose switch is off. */
  readonly enabled?: false;
  readonly starts: ReadonlyArray<FixtureTrigger>;
  /** The book's strip, one letter per run, oldest first. */
  readonly strip: string;
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

/** The book's workflows, in the book's order, which is the list's: by group, then by name. */
const BOOK_WORKFLOWS: ReadonlyArray<FixtureWorkflow> = [
  // Needs you.
  {
    name: "Rotate prod keys",
    starts: [onSchedule("0 8 * * 2", at("2026-10-06", "08:00"))],
    strip: "dddddddddddw",
    lastRunAt: at(TODAY, "08:00"),
    waiting: {
      stepId: "rotate",
      command: "aws iam delete-access-key --user-name deploy-bot --access-key-id AKIA4XQ7",
    },
  },
  {
    name: "Ship release",
    starts: [
      onEvent("github.issue.labeled", "release_issue"),
      onSchedule("0 14 * * 5", at("2026-10-02", "14:00"), { triggerId: "release_train" }),
    ],
    strip: "dddfdddddddfddddfcrw",
    lastRunAt: at(TODAY, "09:12"),
    failedStepId: "review",
    live: { awaitedSignalIds: ["pr_merged"] },
    waiting: { stepId: "security", command: "npm audit fix --force" },
  },
  // Failing.
  {
    name: "Label new issues",
    starts: [onEvent("github.issue.opened", "issue_opened", { error: "No such key: labels" })],
    strip: "dddddddddddd",
    lastRunAt: at(TODAY, "06:21"),
  },
  {
    name: "Nightly backup check",
    starts: [onSchedule("30 2 * * *", at("2026-09-30", "02:30"))],
    strip: "ddddddddddddddddddff",
    lastRunAt: at(TODAY, "02:30"),
    failedStepId: "compare",
  },
  {
    name: "Reload staging",
    starts: [onEvent("github.pr.merged")],
    strip: "dddddddfdddddddddfdf",
    lastRunAt: at(TODAY, "09:18"),
    failedStepId: "smoke",
  },
  {
    name: "Watch flaky tests",
    starts: [onEvent("run.failed")],
    strip: "dddddfdddf",
    lastRunAt: at(TODAY, "03:41"),
    failedStepId: "diagnose",
  },
  // Running.
  {
    name: "Fix bug",
    starts: [onEvent("github.issue.labeled")],
    strip: "ddddfdddddddrdfdddr",
    lastRunAt: at(TODAY, "09:27"),
    failedStepId: "test",
    live: { activeStepIds: ["fix"] },
  },
  {
    name: "Investigate",
    starts: [onEvent("github.issue.assigned")],
    strip: "dddddddr",
    lastRunAt: at(TODAY, "09:35"),
    live: { activeStepIds: ["investigate"] },
  },
  {
    name: "Review dependabot",
    starts: [onEvent("github.pr.opened")],
    strip: "ddddddddddddddddddrr",
    lastRunAt: at(TODAY, "09:37"),
    live: { activeStepIds: ["review"] },
  },
  {
    name: "Translate docs",
    starts: [onEvent("github.pr.merged")],
    strip: "dddddddr",
    lastRunAt: at(TODAY, "09:30"),
    live: { activeStepIds: ["translate"] },
  },
  // Everything else.
  {
    name: "Assign reviewers",
    starts: [onEvent("github.pr.opened")],
    strip: "ddddddddddddddddddd",
    lastRunAt: at(TODAY, "08:53"),
  },
  {
    name: "Audit IAM roles",
    starts: [onSchedule("0 7 1 * *", at("2026-10-01", "07:00"))],
    strip: "dddddd",
    lastRunAt: at("2026-09-01", "07:00"),
  },
  {
    name: "Bump dependencies",
    starts: [onSchedule("0 6 * * 1", at("2026-10-05", "06:00"))],
    strip: "ddddddddfddd",
    lastRunAt: at("2026-09-28", "06:00"),
    failedStepId: "test",
  },
  {
    name: "Check closed issues",
    starts: [onEvent("github.issue.closed")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "08:26"),
  },
  {
    name: "Check SSL expiry",
    starts: [onSchedule("0 8 * * *", at("2026-09-30", "08:00"))],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "08:00"),
  },
  {
    name: "Clean preview envs",
    starts: [onEvent("github.pr.closed")],
    strip: "dddddddddddcdddddddd",
    lastRunAt: at(TODAY, "06:29"),
  },
  {
    name: "Close stale PRs",
    starts: [onSchedule("0 5 * * 1", at("2026-10-05", "05:00"))],
    strip: "dddddddd",
    lastRunAt: at("2026-09-28", "05:00"),
  },
  {
    name: "Close stale tasks",
    starts: [onSchedule("0 4 * * 0", at("2026-10-04", "04:00"))],
    strip: "dddddddddd",
    lastRunAt: at("2026-09-27", "04:00"),
  },
  {
    name: "Compress screenshots",
    starts: [onEvent("github.pr.synchronized")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "09:07"),
  },
  {
    name: "Copy edit blog",
    starts: [onEvent("github.pr.opened")],
    strip: "ddddddd",
    lastRunAt: at("2026-09-26", "11:00"),
  },
  {
    name: "Draft changelog",
    starts: [onEvent("github.pr.merged")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "09:19"),
  },
  {
    name: "Draft reply",
    starts: [onEvent("github.issue.commented")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "09:32"),
  },
  {
    name: "Escalate stuck tasks",
    starts: [onEvent("task.updated")],
    strip: "ddddd",
    lastRunAt: at("2026-09-27", "15:00"),
  },
  {
    name: "Explain failed runs",
    starts: [onEvent("run.failed")],
    strip: "ddddddddddddd",
    lastRunAt: at(TODAY, "03:39"),
  },
  {
    name: "Lint docs",
    starts: [onEvent("github.pr.opened")],
    strip: "ddddfdddd",
    lastRunAt: at("2026-09-28", "16:00"),
    failedStepId: "lint",
  },
  {
    name: "Merge approved PRs",
    starts: [onEvent("github.pr.labeled")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "08:50"),
  },
  {
    name: "Nightly e2e",
    starts: [onSchedule("0 1 * * *", at("2026-09-30", "01:00"))],
    strip: "dddddddddddddddfdddd",
    lastRunAt: at(TODAY, "01:00"),
    failedStepId: "e2e",
  },
  {
    name: "Notify on-call",
    starts: [onEvent("run.failed")],
    strip: "ddddddddddddd",
    lastRunAt: at(TODAY, "03:38"),
  },
  {
    name: "Payout report",
    starts: [onSchedule("0 7 1 * *", at("2026-10-01", "07:00"))],
    strip: "ddddd",
    lastRunAt: at("2026-09-01", "07:00"),
  },
  {
    name: "Plan sprint",
    starts: [onSchedule("0 9 * * 1", at("2026-10-05", "09:00"))],
    strip: "ddddddd",
    lastRunAt: at("2026-09-28", "09:00"),
  },
  {
    name: "Post release notes",
    starts: [onEvent("run.completed")],
    strip: "dddddddddd",
    lastRunAt: at("2026-09-23", "17:00"),
  },
  {
    name: "Prune branches",
    enabled: false,
    starts: [onSchedule("0 3 * * 6")],
    strip: "",
  },
  {
    name: "Rebase open PRs",
    starts: [onEvent("github.pr.merged")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "09:19"),
  },
  {
    name: "Refresh demo data",
    enabled: false,
    starts: [onSchedule("0 6 * * 1")],
    strip: "ddfddd",
    lastRunAt: at("2026-08-17", "06:00"),
    failedStepId: "seed",
  },
  {
    name: "Respond to reviews",
    starts: [onEvent("github.pr.commented")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "09:24"),
  },
  {
    name: "Retry cancelled runs",
    starts: [onEvent("run.cancelled")],
    strip: "ddd",
    lastRunAt: at("2026-09-20", "12:00"),
  },
  {
    name: "Rotate secrets",
    enabled: false,
    starts: [onSchedule("0 7 1 */3 *")],
    strip: "dd",
    lastRunAt: at("2026-07-01", "07:00"),
  },
  {
    name: "Scan for secrets",
    starts: [onEvent("github.pr.synchronized")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "09:07"),
  },
  {
    name: "Summarize standup",
    starts: [onSchedule("0 9 * * 1-5", at("2026-09-30", "08:00"), { timezone: "Europe/London" })],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "08:00"),
  },
  {
    name: "Sync translations",
    starts: [onEvent("github.pr.labeled")],
    strip: "dddddddd",
    lastRunAt: at("2026-09-27", "10:00"),
  },
  {
    name: "Triage",
    starts: [onEvent("github.issue.opened"), onEvent("github.issue.reopened")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "06:21"),
  },
  {
    name: "Triage new tasks",
    starts: [onEvent("task.created")],
    strip: "dddddddddddddddddddd",
    lastRunAt: at(TODAY, "09:03"),
  },
  {
    name: "Weekly metrics",
    starts: [onSchedule("0 8 * * 1", at("2026-10-05", "08:00"), { paused: true })],
    strip: "dddddddd",
    lastRunAt: at("2026-09-14", "08:00"),
  },
  {
    name: "Welcome contributors",
    starts: [onEvent("github.pr.opened")],
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

/** Returns the run a strip's `letter` stands for, with the fields every run shares in `fields`. */
const buildRun = (
  letter: string,
  fields: Pick<RunSummary, "id" | "workflowId" | "workflowName" | "origin" | "createdAt">,
  workflow: FixtureWorkflow,
): RunSummary => {
  const { createdAt } = fields;
  switch (letter) {
    case "d":
      return {
        ...fields,
        status: "completed",
        startedAt: createdAt,
        finishedAt: addMinutes(createdAt, 5),
      };
    case "f":
      return {
        ...fields,
        status: "failed",
        failureReason: "step-failed",
        failedStepId: workflow.failedStepId ?? "run",
        startedAt: createdAt,
        finishedAt: addMinutes(createdAt, 5),
      };
    case "c":
      return { ...fields, status: "cancelled", finishedAt: addMinutes(createdAt, 3) };
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
      throw new Error(`The fixture's strip has a letter "${letter}" that stands for no run.`);
  }
};

/** Returns the session of `run`'s step `stepId`, waiting on the user to run `command`. */
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
    runId: run.id,
    stepId,
    openRequests: [request],
    lastActivityAt: run.createdAt,
  };
};

/** What the workflow list reads, as the controller would return it. */
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
}

/** Builds the records from the book's workflows. */
const buildWorkflowsRecords = (): WorkflowsRecords => {
  const workflows: WorkflowSummary[] = [];
  const triggers: Trigger[] = [];
  const newestRuns: RunSummary[] = [];
  const runningRuns: RunSummary[] = [];
  const agentSessions: Session[] = [];
  let runNumber = 0;

  BOOK_WORKFLOWS.forEach((book, index) => {
    const workflow: WorkflowSummary = {
      id: buildId("7800", index + 1),
      name: book.name,
      enabled: book.enabled ?? true,
      updatedAt: UPDATED_AT,
    };
    workflows.push(workflow);
    for (const start of book.starts) {
      triggers.push({
        workflowId: workflow.id,
        workflowName: workflow.name,
        triggerId: start.triggerId,
        kind: "start",
        on: start.on,
        status: start.paused === true ? "paused" : "active",
        health:
          start.error === undefined
            ? { state: "ok" }
            : { state: "error", message: start.error, at: book.lastRunAt ?? UPDATED_AT },
        ...(start.nextFireAt !== undefined && { nextFireAt: start.nextFireAt }),
        createdAt: UPDATED_AT,
        updatedAt: UPDATED_AT,
      });
    }

    // Newest first, as `run.query` lists them.
    const letters = [...book.strip].toReversed();
    const strip = letters.map((letter, age) => {
      runNumber += 1;
      const run = buildRun(
        letter,
        {
          id: buildId("7900", runNumber),
          workflowId: workflow.id,
          workflowName: workflow.name,
          origin: { kind: "manual", actor: "user" },
          createdAt: subtractDays(book.lastRunAt ?? UPDATED_AT, age),
        },
        book,
      );
      if (run.status === "running") runningRuns.push(run);
      if (letter === "w" && book.waiting !== undefined) {
        agentSessions.push(
          buildWaitingSession(runNumber, run, book.waiting.stepId, book.waiting.command),
        );
      }
      return run;
    });
    newestRuns.push(...strip);
  });

  return { workflows, triggers, newestRuns, runningRuns, agentSessions };
};

export const WORKFLOWS_RECORDS: WorkflowsRecords = buildWorkflowsRecords();
