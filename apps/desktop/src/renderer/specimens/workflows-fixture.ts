/**
 * PROTOTYPE. The records the Workflows specimen seeds its query cache with,
 * as the controller would return them once the contract has the additions
 * in screens/workflows/proposed-contract.ts.
 *
 * - 44 workflows, so the list fills its four groups and scrolls: two wait on
 *   the user, four are failing, four are running, and the rest are quiet.
 * - Ship release is written out in full: two start triggers, a signal
 *   trigger, six agent steps, a review loop and a join. Every other workflow
 *   is a chain of one to four steps behind its triggers.
 * - Every workflow has up to 20 runs, newest first, each with its step
 *   records and the sessions its agent steps started.
 *
 * Every event kind and every action is one the controller or the GitHub
 * plugin has, so the page never draws a name a user could not write.
 */
import {
  renderWorkflowSource,
  type Agent,
  type Run,
  type RunOrigin,
  type RunSummary,
  type Session,
  type StepRecord,
  type Trigger,
  type TriggerHealth,
  type Workflow,
  type WorkflowAction,
  type WorkflowDefinition,
} from "@hercule/contract";
import type { RecentRun, WorkflowListEntry } from "../screens/workflows/proposed-contract";
import {
  RECENT_RUN_LIMIT,
  type SessionWithToolCalls,
} from "../screens/workflows/proposed-contract";
import { CLAUDE_SONNET, SPECIMEN_NOW, buildSpecimenSession } from "./sidebar-fixture";

/** Returns the time `minutes` minutes before `SPECIMEN_NOW`, as a timestamp. */
const minutesAgo = (minutes: number): string =>
  new Date(SPECIMEN_NOW - minutes * 60_000).toISOString();

/** Returns a UUIDv7-shaped id: the shared prefix, then `kind` and `n` as twelve hex digits. */
export const buildId = (kind: "a" | "c" | "d" | "e", n: number): string =>
  `01a0ec64-6e80-7000-8000-${kind}${n.toString(16).padStart(11, "0")}`;

const CREATED_AT = "2026-06-02T08:00:00.000Z";

type AgentName = "Writer" | "Auditor" | "Tester" | "Reviewer" | "Coder";

/** Returns the Agent called `name`, with `number` in its id. */
const buildAgent = (name: AgentName, number: number): Agent => ({
  id: buildId("a", number),
  name,
  systemPrompt: `You are ${name}.`,
  instanceId: CLAUDE_SONNET.instanceId,
  permissionProfileId: "01a0ec64-6e80-7000-8000-b00000000003",
  accessMode: "approval-required",
  model: null,
  disallowedTools: [],
  unenforced: [],
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
});

/** The Agents the workflows' agent steps run as. */
const AGENTS: Readonly<Record<AgentName, Agent>> = {
  Writer: buildAgent("Writer", 1),
  Auditor: buildAgent("Auditor", 2),
  Tester: buildAgent("Tester", 3),
  Reviewer: buildAgent("Reviewer", 4),
  Coder: buildAgent("Coder", 5),
};

/** Returns a workflow action as the catalog lists it. */
const buildAction = (
  id: string,
  displayName: string,
  runsIn: WorkflowAction["runsIn"],
  connectionType?: string,
): WorkflowAction => ({
  id,
  displayName,
  description: displayName,
  runsIn,
  inputSchema: { type: "object" },
  ...(connectionType === undefined ? {} : { connection: { type: connectionType } }),
});

/** The actions the workflows call, with the display names the controller and the GitHub plugin give them. */
const WORKFLOW_ACTIONS: ReadonlyArray<WorkflowAction> = [
  buildAction("task.create", "Create a task", "controller"),
  buildAction("task.update", "Update a task", "controller"),
  buildAction("task.query", "Find tasks", "controller"),
  buildAction("run.start", "Start a run", "controller"),
  buildAction("notification.create", "Send a notification", "controller"),
  buildAction("git.commit", "Commit changes", "workspace"),
  buildAction("git.push", "Push a branch", "workspace"),
  buildAction("github/issue.comment", "Comment on a GitHub issue", "controller", "github/github"),
  buildAction("github/issue.update", "Update a GitHub issue", "controller", "github/github"),
  buildAction(
    "github/pr.comment",
    "Comment on a GitHub pull request",
    "controller",
    "github/github",
  ),
  buildAction("github/pr.create", "Open a GitHub pull request", "controller", "github/github"),
  buildAction("github/pr.merge", "Merge a GitHub pull request", "controller", "github/github"),
  buildAction("github/pr.review", "Review a GitHub pull request", "controller", "github/github"),
  buildAction("github/pr.update", "Update a GitHub pull request", "controller", "github/github"),
];

/**
 * A start trigger of a chain workflow: on an event, or on a schedule. A
 * schedule without a timezone of its own fires in the user's timezone, which
 * the specimens leave at UTC.
 */
type SpecimenTrigger =
  | {
      readonly id: string;
      readonly event: string;
      readonly filter?: string;
      readonly health?: TriggerHealth;
    }
  | {
      readonly id: string;
      readonly schedule: string;
      readonly timezone?: string;
      /** How long until the schedule next comes due. */
      readonly nextInMinutes: number;
      readonly paused?: boolean;
    };

/** A step of a chain workflow: an agent step and its prompt, or an action step. */
type SpecimenStep =
  | { readonly id: string; readonly agent: AgentName; readonly prompt: string }
  | { readonly id: string; readonly action: string };

/**
 * A chain workflow and its runs. `history` holds one letter per run, newest
 * first:
 *
 * - `w`: running, and a session waits on the user at `liveAt`;
 * - `r`: running, at `liveAt`;
 * - `o`: completed;
 * - `f`: failed at `failsAt`;
 * - `x`: cancelled.
 */
interface SpecimenWorkflow {
  readonly name: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly triggers: ReadonlyArray<SpecimenTrigger>;
  readonly steps: ReadonlyArray<SpecimenStep>;
  readonly history: string;
  readonly latestMinutesAgo?: number;
  readonly everyMinutes?: number;
  readonly takesMinutes?: number;
  /** The step a live run is at. The first step when absent. */
  readonly liveAt?: string;
  /** The step a failed run failed at. The last step when absent. */
  readonly failsAt?: string;
  /** The command a waiting run's session asks the user to approve. */
  readonly approve?: string;
}

const DAY = 24 * 60;
const WEEK = 7 * DAY;

/** The chain workflows, in the order the controller lists them, by name. */
const CHAIN_WORKFLOWS: ReadonlyArray<SpecimenWorkflow> = [
  {
    name: "Assign reviewers",
    triggers: [{ id: "pr_opened", event: "github.pr.opened" }],
    steps: [
      { id: "pick", agent: "Reviewer", prompt: "Pick two reviewers who know the changed files." },
      { id: "assign", action: "github/pr.update" },
    ],
    history: "ooooooooooooooooooo",
    latestMinutesAgo: 48,
    everyMinutes: 190,
    takesMinutes: 2,
  },
  {
    name: "Audit IAM roles",
    description: "Lists roles nobody used in 90 days and files a task to remove them.",
    triggers: [{ id: "monthly", schedule: "0 7 1 * *", nextInMinutes: DAY + 21 * 60 + 19 }],
    steps: [
      { id: "audit", agent: "Auditor", prompt: "List the IAM roles nobody used in 90 days." },
      { id: "file", action: "task.create" },
    ],
    history: "oooooo",
    latestMinutesAgo: 28 * DAY + 2 * 60 + 41,
    everyMinutes: 30 * DAY,
    takesMinutes: 14,
  },
  {
    name: "Bump dependencies",
    triggers: [{ id: "monday", schedule: "0 6 * * 1", nextInMinutes: 5 * DAY + 20 * 60 + 19 }],
    steps: [
      {
        id: "bump",
        agent: "Coder",
        prompt: "Bump every dependency one minor version and fix what breaks.",
      },
      { id: "commit", action: "git.commit" },
      { id: "push", action: "git.push" },
      { id: "open_pr", action: "github/pr.create" },
    ],
    history: "ooofoooooooo",
    latestMinutesAgo: DAY + 3 * 60 + 41,
    everyMinutes: WEEK,
    takesMinutes: 26,
    failsAt: "push",
  },
  {
    name: "Check closed issues",
    triggers: [{ id: "issue_closed", event: "github.issue.closed" }],
    steps: [
      {
        id: "verify",
        agent: "Tester",
        prompt: "Check that the fix for the closed issue is on main.",
      },
      { id: "reopen", action: "github/issue.update" },
    ],
    history: "oooooooooooooooooooo",
    latestMinutesAgo: 75,
    everyMinutes: 160,
    takesMinutes: 6,
  },
  {
    name: "Check SSL expiry",
    triggers: [{ id: "daily", schedule: "0 8 * * *", nextInMinutes: 22 * 60 + 19 }],
    steps: [
      {
        id: "check",
        agent: "Auditor",
        prompt: "List the certificates that expire within 30 days.",
      },
      { id: "notify", action: "notification.create" },
    ],
    history: "ooooooooooooooooooooo",
    latestMinutesAgo: 101,
    everyMinutes: DAY,
    takesMinutes: 3,
  },
  {
    name: "Clean preview envs",
    triggers: [{ id: "pr_closed", event: "github.pr.closed" }],
    steps: [
      {
        id: "clean",
        agent: "Coder",
        prompt: "Tear down the preview environment of the closed pull request.",
      },
      { id: "comment", action: "github/pr.comment" },
    ],
    history: "ooooooooxooooooooooo",
    latestMinutesAgo: 3 * 60 + 12,
    everyMinutes: 300,
    takesMinutes: 4,
  },
  {
    name: "Close stale PRs",
    triggers: [{ id: "monday", schedule: "0 5 * * 1", nextInMinutes: 5 * DAY + 19 * 60 + 19 }],
    steps: [
      {
        id: "find",
        agent: "Reviewer",
        prompt: "Find the pull requests nobody touched in 30 days.",
      },
      { id: "close", action: "github/pr.update" },
    ],
    history: "oooooooo",
    latestMinutesAgo: DAY + 4 * 60 + 41,
    everyMinutes: WEEK,
    takesMinutes: 5,
  },
  {
    name: "Close stale tasks",
    triggers: [{ id: "sunday", schedule: "0 4 * * 0", nextInMinutes: 4 * DAY + 18 * 60 + 19 }],
    steps: [
      { id: "find", action: "task.query" },
      { id: "close", action: "task.update" },
    ],
    history: "oooooooooo",
    latestMinutesAgo: 2 * DAY + 5 * 60 + 41,
    everyMinutes: WEEK,
    takesMinutes: 1,
  },
  {
    name: "Compress screenshots",
    triggers: [{ id: "pr_pushed", event: "github.pr.synchronized" }],
    steps: [
      {
        id: "compress",
        agent: "Coder",
        prompt: "Compress every changed PNG without visible loss.",
      },
      { id: "commit", action: "git.commit" },
      { id: "push", action: "git.push" },
    ],
    history: "oooooooooooooooooooo",
    latestMinutesAgo: 34,
    everyMinutes: 70,
    takesMinutes: 3,
  },
  {
    name: "Copy edit blog",
    triggers: [
      {
        id: "post_opened",
        event: "github.pr.opened",
        filter: 'event.payload.pull_request.head.ref.startsWith("blog/")',
      },
    ],
    steps: [
      { id: "edit", agent: "Writer", prompt: "Copy edit the post. Keep the author's voice." },
      { id: "review", action: "github/pr.review" },
    ],
    history: "ooooooo",
    latestMinutesAgo: 3 * DAY + 60,
    everyMinutes: 4 * DAY,
    takesMinutes: 9,
  },
  {
    name: "Draft changelog",
    triggers: [{ id: "pr_merged", event: "github.pr.merged" }],
    steps: [
      {
        id: "draft",
        agent: "Writer",
        prompt: "Add the merged pull request to the unreleased section.",
      },
      { id: "commit", action: "git.commit" },
    ],
    history: "oooooooooooooooooooo",
    latestMinutesAgo: 22,
    everyMinutes: 130,
    takesMinutes: 4,
  },
  {
    name: "Draft reply",
    triggers: [{ id: "commented", event: "github.issue.commented" }],
    steps: [
      {
        id: "draft",
        agent: "Writer",
        prompt: "Draft a reply to the comment for a maintainer to send.",
      },
      { id: "reply", action: "github/issue.comment" },
    ],
    history: "ooooooooooooooooooooo",
    latestMinutesAgo: 9,
    everyMinutes: 55,
    takesMinutes: 3,
  },
  {
    name: "Escalate stuck tasks",
    triggers: [
      {
        id: "task_updated",
        event: "task.updated",
        filter: 'event.payload.task.status == "blocked"',
      },
    ],
    steps: [
      {
        id: "summarize",
        agent: "Writer",
        prompt: "Summarize why the task is blocked and who can unblock it.",
      },
      { id: "notify", action: "notification.create" },
    ],
    history: "ooooo",
    latestMinutesAgo: 2 * DAY + 7 * 60,
    everyMinutes: 3 * DAY,
    takesMinutes: 2,
  },
  {
    name: "Explain failed runs",
    triggers: [{ id: "run_failed", event: "run.failed" }],
    steps: [
      {
        id: "explain",
        agent: "Auditor",
        prompt: "Read the failed run and explain what went wrong.",
      },
      { id: "notify", action: "notification.create" },
    ],
    history: "ooooooooooooo",
    latestMinutesAgo: 6 * 60 + 2,
    everyMinutes: 9 * 60,
    takesMinutes: 3,
  },
  {
    name: "Fix bug",
    description: "Reproduces a bug labelled bug, fixes it, and opens a pull request.",
    triggers: [
      {
        id: "bug_labeled",
        event: "github.issue.labeled",
        filter: 'event.payload.label.name == "bug"',
      },
    ],
    steps: [
      { id: "reproduce", agent: "Tester", prompt: "Write a failing test that reproduces the bug." },
      { id: "fix", agent: "Coder", prompt: "Make the failing test pass with the smallest change." },
      { id: "push", action: "git.push" },
      { id: "open_pr", action: "github/pr.create" },
    ],
    history: "roooforooooooofoooo",
    latestMinutesAgo: 14,
    everyMinutes: 6 * 60,
    takesMinutes: 41,
    liveAt: "fix",
    failsAt: "fix",
  },
  {
    name: "Investigate",
    triggers: [{ id: "assigned", event: "github.issue.assigned" }],
    steps: [
      {
        id: "investigate",
        agent: "Auditor",
        prompt: "Find the cause of the issue and the files involved.",
      },
      { id: "comment", action: "github/issue.comment" },
    ],
    history: "rooooooo",
    latestMinutesAgo: 6,
    everyMinutes: DAY,
    takesMinutes: 18,
  },
  {
    name: "Label new issues",
    triggers: [
      {
        id: "issue_opened",
        event: "github.issue.opened",
        filter: "event.payload.issue.labels.size() == 0",
        health: {
          state: "error",
          message: "No such key: labels",
          at: minutesAgo(3 * 60 + 5),
        },
      },
    ],
    steps: [
      { id: "label", agent: "Writer", prompt: "Pick the labels that fit the issue." },
      { id: "apply", action: "github/issue.update" },
    ],
    history: "oooooooooooo",
    latestMinutesAgo: 3 * 60 + 20,
    everyMinutes: 200,
    takesMinutes: 2,
  },
  {
    name: "Lint docs",
    triggers: [
      {
        id: "docs_opened",
        event: "github.pr.opened",
        filter: 'event.payload.pull_request.title.startsWith("docs")',
      },
    ],
    steps: [
      {
        id: "lint",
        agent: "Reviewer",
        prompt: "Check the changed docs for broken links and stale names.",
      },
      { id: "review", action: "github/pr.review" },
    ],
    history: "oooofoooo",
    latestMinutesAgo: DAY + 5 * 60,
    everyMinutes: 2 * DAY,
    takesMinutes: 5,
  },
  {
    name: "Merge approved PRs",
    triggers: [
      {
        id: "automerge",
        event: "github.pr.labeled",
        filter: 'event.payload.label.name == "automerge"',
      },
    ],
    steps: [{ id: "merge", action: "github/pr.merge" }],
    history: "oooooooooooooooooooo",
    latestMinutesAgo: 51,
    everyMinutes: 140,
    takesMinutes: 1,
  },
  {
    name: "Nightly backup check",
    description: "Restores last night's backup into a scratch database and checks the row counts.",
    triggers: [{ id: "nightly", schedule: "30 2 * * *", nextInMinutes: 16 * 60 + 49 }],
    steps: [
      {
        id: "restore",
        agent: "Auditor",
        prompt: "Restore last night's backup into a scratch database.",
      },
      { id: "compare", agent: "Tester", prompt: "Compare the row counts with production." },
      { id: "notify", action: "notification.create" },
    ],
    history: "ffoooooooooooooooooo",
    latestMinutesAgo: 7 * 60 + 11,
    everyMinutes: DAY,
    takesMinutes: 22,
    failsAt: "compare",
  },
  {
    name: "Nightly e2e",
    triggers: [{ id: "nightly", schedule: "0 1 * * *", nextInMinutes: 15 * 60 + 19 }],
    steps: [
      { id: "run", agent: "Tester", prompt: "Run the end-to-end suite against staging." },
      { id: "file", action: "task.create" },
    ],
    history: "oooofooooooooooooooo",
    latestMinutesAgo: 8 * 60 + 41,
    everyMinutes: DAY,
    takesMinutes: 37,
  },
  {
    name: "Notify on-call",
    triggers: [{ id: "run_failed", event: "run.failed" }],
    steps: [{ id: "notify", action: "notification.create" }],
    history: "ooooooooooooo",
    latestMinutesAgo: 6 * 60 + 3,
    everyMinutes: 9 * 60,
    takesMinutes: 1,
  },
  {
    name: "Payout report",
    triggers: [{ id: "monthly", schedule: "0 7 1 * *", nextInMinutes: DAY + 21 * 60 + 19 }],
    steps: [
      { id: "collect", agent: "Auditor", prompt: "Collect last month's payouts per merchant." },
      { id: "write", agent: "Writer", prompt: "Write the payout report." },
      { id: "notify", action: "notification.create" },
    ],
    history: "ooooo",
    latestMinutesAgo: 28 * DAY + 2 * 60 + 41,
    everyMinutes: 30 * DAY,
    takesMinutes: 19,
  },
  {
    name: "Plan sprint",
    triggers: [{ id: "monday", schedule: "0 9 * * 1", nextInMinutes: 5 * DAY + 23 * 60 + 19 }],
    steps: [
      {
        id: "plan",
        agent: "Writer",
        prompt: "Propose the sprint from the open tasks, most urgent first.",
      },
      { id: "file", action: "task.create" },
    ],
    history: "ooooooo",
    latestMinutesAgo: DAY + 41,
    everyMinutes: WEEK,
    takesMinutes: 7,
  },
  {
    name: "Post release notes",
    triggers: [
      {
        id: "released",
        event: "run.completed",
        filter: 'event.payload.workflowId == "01a0ec64-6e80-7000-8000-c00000000001"',
      },
    ],
    steps: [
      { id: "write", agent: "Writer", prompt: "Write release notes from the run's changelog." },
      { id: "post", action: "github/issue.comment" },
    ],
    history: "oooooooooo",
    latestMinutesAgo: 6 * DAY + 3 * 60,
    everyMinutes: WEEK,
    takesMinutes: 4,
  },
  {
    name: "Prune branches",
    enabled: false,
    triggers: [{ id: "weekly", schedule: "0 3 * * 6", nextInMinutes: 4 * DAY + 17 * 60 + 19 }],
    steps: [
      { id: "prune", agent: "Coder", prompt: "Delete the merged branches older than 30 days." },
    ],
    history: "",
  },
  {
    name: "Rebase open PRs",
    triggers: [{ id: "main_moved", event: "github.pr.merged" }],
    steps: [
      { id: "rebase", agent: "Coder", prompt: "Rebase each open pull request on main." },
      { id: "push", action: "git.push" },
    ],
    history: "oooooooooooooooooooo",
    latestMinutesAgo: 22,
    everyMinutes: 130,
    takesMinutes: 8,
  },
  {
    name: "Refresh demo data",
    enabled: false,
    triggers: [{ id: "weekly", schedule: "0 6 * * 1", nextInMinutes: 5 * DAY + 20 * 60 + 19 }],
    steps: [
      { id: "refresh", agent: "Coder", prompt: "Regenerate the demo data from the seed script." },
      { id: "commit", action: "git.commit" },
      { id: "push", action: "git.push" },
    ],
    history: "ooofoo",
    latestMinutesAgo: 43 * DAY + 3 * 60 + 41,
    everyMinutes: WEEK,
    takesMinutes: 12,
  },
  {
    name: "Reload staging",
    description: "Pushes main to the staging branch after every merge and smoke tests it.",
    triggers: [{ id: "merged", event: "github.pr.merged" }],
    steps: [
      { id: "push", action: "git.push" },
      { id: "smoke", agent: "Tester", prompt: "Smoke test staging: sign in, check out, refund." },
    ],
    history: "fofooooooooofooooooo",
    latestMinutesAgo: 23,
    everyMinutes: 130,
    takesMinutes: 6,
    failsAt: "smoke",
  },
  {
    name: "Respond to reviews",
    triggers: [{ id: "pr_commented", event: "github.pr.commented" }],
    steps: [
      { id: "respond", agent: "Coder", prompt: "Address the review comment with a commit." },
      { id: "push", action: "git.push" },
    ],
    history: "oooooooooooooooooooo",
    latestMinutesAgo: 17,
    everyMinutes: 45,
    takesMinutes: 6,
  },
  {
    name: "Retry cancelled runs",
    triggers: [{ id: "run_cancelled", event: "run.cancelled" }],
    steps: [{ id: "restart", action: "run.start" }],
    history: "ooo",
    latestMinutesAgo: 9 * DAY,
    everyMinutes: 6 * DAY,
    takesMinutes: 1,
  },
  {
    name: "Review dependabot",
    triggers: [
      {
        id: "bot_opened",
        event: "github.pr.opened",
        filter: 'event.payload.pull_request.user.login == "dependabot[bot]"',
      },
    ],
    steps: [
      {
        id: "review",
        agent: "Reviewer",
        prompt: "Read the changelog of the bumped package and run the tests.",
      },
      { id: "merge", action: "github/pr.merge" },
    ],
    history: "rroooooooooooooooooo",
    latestMinutesAgo: 4,
    everyMinutes: 9,
    takesMinutes: 11,
  },
  {
    name: "Rotate prod keys",
    description: "Rotates the deploy keys every Tuesday. Asks before it revokes the old ones.",
    triggers: [{ id: "tuesday", schedule: "0 8 * * 2", nextInMinutes: WEEK - 101 }],
    steps: [
      { id: "plan", agent: "Auditor", prompt: "List the keys older than 30 days." },
      {
        id: "rotate",
        agent: "Coder",
        prompt: "Create new keys, update the secrets, and revoke the old keys.",
      },
      { id: "notify", action: "notification.create" },
    ],
    history: "wooooooooooo",
    latestMinutesAgo: 101,
    everyMinutes: WEEK,
    takesMinutes: 15,
    liveAt: "rotate",
    approve: "aws iam delete-access-key --user-name deploy-bot --access-key-id AKIA4XQ7",
  },
  {
    name: "Rotate secrets",
    enabled: false,
    triggers: [
      {
        id: "quarterly",
        schedule: "0 7 1 */3 *",
        nextInMinutes: 2 * DAY + 21 * 60 + 19,
        paused: true,
      },
    ],
    steps: [{ id: "rotate", agent: "Coder", prompt: "Rotate the application secrets." }],
    history: "oo",
    latestMinutesAgo: 90 * DAY,
    everyMinutes: 90 * DAY,
    takesMinutes: 9,
  },
  {
    name: "Scan for secrets",
    triggers: [{ id: "pr_pushed", event: "github.pr.synchronized" }],
    steps: [
      { id: "scan", agent: "Auditor", prompt: "Check the pushed commits for keys and tokens." },
      { id: "review", action: "github/pr.review" },
    ],
    history: "oooooooooooooooooooo",
    latestMinutesAgo: 34,
    everyMinutes: 70,
    takesMinutes: 2,
  },
  {
    name: "Summarize standup",
    // 09:00 in London is 08:00 UTC in September: today's run started 1 hour 41
    // minutes ago, and Wednesday's starts in 22 hours 19 minutes.
    triggers: [
      {
        id: "weekdays",
        schedule: "0 9 * * 1-5",
        timezone: "Europe/London",
        nextInMinutes: 22 * 60 + 19,
      },
    ],
    steps: [
      {
        id: "summarize",
        agent: "Writer",
        prompt: "Summarize yesterday's merged work and today's open tasks.",
      },
      { id: "notify", action: "notification.create" },
    ],
    history: "oooooooooooooooooooo",
    latestMinutesAgo: 60 + 41,
    everyMinutes: DAY,
    takesMinutes: 3,
  },
  {
    name: "Sync translations",
    triggers: [
      { id: "strings", event: "github.pr.labeled", filter: 'event.payload.label.name == "i18n"' },
    ],
    steps: [
      {
        id: "sync",
        agent: "Writer",
        prompt: "Translate the new strings into German, French and Dutch.",
      },
      { id: "commit", action: "git.commit" },
      { id: "push", action: "git.push" },
    ],
    history: "oooooooo",
    latestMinutesAgo: 2 * DAY + 60,
    everyMinutes: 3 * DAY,
    takesMinutes: 13,
  },
  {
    name: "Translate docs",
    triggers: [
      {
        id: "docs_merged",
        event: "github.pr.merged",
        filter: 'event.payload.pull_request.title.startsWith("docs")',
      },
    ],
    steps: [
      { id: "translate", agent: "Writer", prompt: "Translate the changed pages." },
      { id: "commit", action: "git.commit" },
      { id: "push", action: "git.push" },
    ],
    history: "rooooooo",
    latestMinutesAgo: 11,
    everyMinutes: 2 * DAY,
    takesMinutes: 16,
  },
  {
    name: "Triage",
    description:
      "Reads every new or reopened issue, labels it, and files a task when it is urgent.",
    triggers: [
      { id: "opened", event: "github.issue.opened" },
      { id: "reopened", event: "github.issue.reopened" },
    ],
    steps: [
      {
        id: "triage",
        agent: "Reviewer",
        prompt: "Decide the issue's labels and how urgent it is.",
      },
      { id: "label", action: "github/issue.update" },
      { id: "file", action: "task.create" },
    ],
    history: "oooooooooooooooooooo",
    latestMinutesAgo: 3 * 60 + 20,
    everyMinutes: 200,
    takesMinutes: 4,
  },
  {
    name: "Triage new tasks",
    triggers: [{ id: "task_created", event: "task.created" }],
    steps: [
      { id: "triage", agent: "Writer", prompt: "Set the task's priority and project." },
      { id: "update", action: "task.update" },
    ],
    history: "oooooooooooooooooooo",
    latestMinutesAgo: 38,
    everyMinutes: 95,
    takesMinutes: 2,
  },
  {
    name: "Watch flaky tests",
    triggers: [{ id: "run_failed", event: "run.failed" }],
    steps: [
      {
        id: "diagnose",
        agent: "Tester",
        prompt: "Run the failed test 20 times and say whether it is flaky.",
      },
      { id: "file", action: "task.create" },
    ],
    history: "fooofooooo",
    latestMinutesAgo: 6 * 60,
    everyMinutes: 9 * 60,
    takesMinutes: 24,
    failsAt: "diagnose",
  },
  {
    name: "Weekly metrics",
    triggers: [
      { id: "monday", schedule: "0 8 * * 1", nextInMinutes: 5 * DAY + 22 * 60 + 19, paused: true },
    ],
    steps: [
      {
        id: "compile",
        agent: "Writer",
        prompt: "Compile last week's merged PRs, closed issues and incidents.",
      },
      { id: "notify", action: "notification.create" },
    ],
    history: "oooooooo",
    latestMinutesAgo: 15 * DAY + 1 * 60 + 41,
    everyMinutes: WEEK,
    takesMinutes: 6,
  },
  {
    name: "Welcome contributors",
    triggers: [
      {
        id: "first_pr",
        event: "github.pr.opened",
        filter: 'event.payload.pull_request.author_association == "FIRST_TIME_CONTRIBUTOR"',
      },
    ],
    steps: [
      {
        id: "welcome",
        agent: "Writer",
        prompt: "Thank the contributor and point at the contributing guide.",
      },
      { id: "comment", action: "github/pr.comment" },
    ],
    history: "ooooooooofo",
    latestMinutesAgo: 4 * DAY,
    everyMinutes: 5 * DAY,
    takesMinutes: 2,
  },
];

/** The Ship release workflow's id. Post release notes filters on it. */
export const SHIP_RELEASE_ID = buildId("c", 1);

/** The Ship release workflow, written out in full. */
const SHIP_RELEASE: WorkflowDefinition = {
  name: "Ship release",
  description:
    "Prepares a release in parallel, opens the release PR, and announces it once the PR is merged.",
  inputs: [{ name: "version", schema: { type: "string" }, required: false }],
  triggers: [
    {
      id: "release_issue",
      kind: "start",
      on: {
        kind: "github.issue.labeled",
        connectionId: "any",
        filter: 'event.payload.label.name == "release"',
      },
      inputs: { version: "event.payload.issue.title" },
    },
    {
      id: "release_train",
      kind: "start",
      on: { schedule: "0 14 * * 5" },
    },
    {
      id: "pr_merged",
      kind: "signal",
      on: { kind: "github.pr.merged", connectionId: "any" },
      correlation: { event: "event.payload.number", run: "steps.open_pr.output.number" },
    },
  ],
  steps: [
    {
      id: "changelog",
      kind: "agent",
      agent: AGENTS.Writer.id,
      prompt: "Write the changelog for {{ inputs.version }} from the merged pull requests.",
    },
    {
      id: "security",
      kind: "agent",
      agent: AGENTS.Auditor.id,
      prompt: "Audit the dependencies and fix what you can.",
    },
    {
      id: "test",
      kind: "agent",
      agent: AGENTS.Tester.id,
      prompt: "Run the full test suite and the end-to-end tests.",
    },
    {
      id: "review",
      kind: "agent",
      agent: AGENTS.Reviewer.id,
      prompt: "Review the release diff. Answer approved or changes.",
      entry: true,
      outputSchema: {
        type: "object",
        properties: { verdict: { type: "string", enum: ["approved", "changes"] } },
        required: ["verdict"],
      },
    },
    {
      id: "fix",
      kind: "agent",
      agent: AGENTS.Coder.id,
      prompt: "Make the changes the review asked for.",
    },
    {
      id: "open_pr",
      kind: "action",
      action: "github/pr.create",
      params: {
        connection: "any",
        title: "Release {{ inputs.version }}",
        head: "release/{{ inputs.version }}",
        base: "main",
      },
      join: "all",
    },
    {
      id: "announce",
      kind: "agent",
      agent: AGENTS.Writer.id,
      prompt: "Write the release announcement from the changelog.",
    },
    {
      id: "notify",
      kind: "action",
      action: "notification.create",
      params: { title: "Released {{ inputs.version }}" },
      terminal: true,
    },
  ],
  edges: [
    { from: "changelog", to: "open_pr" },
    { from: "test", to: "open_pr" },
    { from: "security", to: "open_pr" },
    { from: "review", to: "open_pr", condition: 'steps.review.output.verdict == "approved"' },
    { from: "review", to: "fix", condition: 'steps.review.output.verdict == "changes"' },
    { from: "fix", to: "review", maxTraversals: 3 },
    { from: "pr_merged", to: "announce" },
    { from: "announce", to: "notify" },
  ],
};

/**
 * Ship release as it was before its test step ran the end-to-end tests. The
 * oldest runs followed it, so their pages note that the workflow changed.
 */
const SHIP_RELEASE_BEFORE_E2E: WorkflowDefinition = {
  ...SHIP_RELEASE,
  steps: SHIP_RELEASE.steps.map((step) =>
    step.id === "test" && step.kind === "agent"
      ? { ...step, prompt: "Run the full test suite." }
      : step,
  ),
};

// Ship release's edge indexes, in the order of its definition's `edges`.
const [
  CHANGELOG_PR,
  TEST_PR,
  SECURITY_PR,
  REVIEW_PR,
  REVIEW_FIX,
  FIX_REVIEW,
  MERGED_ANNOUNCE,
  ANNOUNCE_NOTIFY,
] = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/** Returns a Ship release run's `edgeTraversals`, from how often it followed each edge by index. */
const countShipReleaseEdges = (followed: Partial<Record<number, number>>): number[] =>
  Array.from({ length: SHIP_RELEASE.edges!.length }, (_, index) => followed[index] ?? 0);

/** Returns the definition of a chain workflow: its triggers, then its steps one after the other. */
const buildChainDefinition = (spec: SpecimenWorkflow): WorkflowDefinition => ({
  name: spec.name,
  ...(spec.description === undefined ? {} : { description: spec.description }),
  triggers: spec.triggers.map((trigger) => ({
    id: trigger.id,
    kind: "start",
    on:
      "schedule" in trigger
        ? {
            schedule: trigger.schedule,
            ...(trigger.timezone === undefined ? {} : { timezone: trigger.timezone }),
          }
        : {
            kind: trigger.event,
            ...(trigger.event.startsWith("github.") ? { connectionId: "any" } : {}),
            ...(trigger.filter === undefined ? {} : { filter: trigger.filter }),
          },
  })),
  steps: spec.steps.map((step) =>
    "agent" in step
      ? { id: step.id, kind: "agent", agent: AGENTS[step.agent].id, prompt: step.prompt }
      : { id: step.id, kind: "action", action: step.action },
  ),
  edges: spec.steps.slice(1).map((step, index) => ({ from: spec.steps[index]!.id, to: step.id })),
});

/** A workflow as `workflow.read` returns it, with the definition its source holds. */
export interface StoredWorkflow {
  readonly workflow: Workflow;
  readonly definition: WorkflowDefinition;
}

/** What the fixture builds for one workflow. */
interface BuiltWorkflow extends StoredWorkflow {
  readonly entry: WorkflowListEntry;
  readonly triggers: ReadonlyArray<Trigger>;
  /** Newest first. */
  readonly runs: ReadonlyArray<Run>;
  readonly sessions: ReadonlyArray<Session>;
}

/** Returns a completed step record that ran from `start` to `end`, in minutes ago. */
const buildCompletedRecord = (
  stepId: string,
  start: number,
  end: number,
  output: Extract<StepRecord, { status: "completed" }>["output"],
  sessionId?: string,
  iteration = 1,
): StepRecord => ({
  stepId,
  iteration,
  ...(sessionId === undefined ? {} : { sessionId }),
  status: "completed",
  startedAt: minutesAgo(start),
  finishedAt: minutesAgo(end),
  output,
});

/**
 * Returns the session an agent step of a run started, `minutes` ago. Its
 * usage and its count of tool calls, the proposed `Session.toolCalls`, follow
 * from its id, so each session has its own and every capture draws the same.
 */
const buildStepSession = (
  id: string,
  workflowName: string,
  runId: string,
  stepId: string,
  agent: Agent,
  minutes: number,
  over: Partial<Session> = {},
): SessionWithToolCalls => {
  const seed = [...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 10_007, 0);
  const inputTokens = 6_000 + ((seed * 37) % 54_000);
  const outputTokens = 400 + ((seed * 13) % 7_600);
  return {
    ...buildSpecimenSession({
      id,
      title: `${workflowName} · ${stepId}`,
      minutesAgo: minutes,
      model: CLAUDE_SONNET,
      agentId: agent.id,
      permissionProfileId: agent.permissionProfileId,
      runId,
      stepId,
      status: "idle",
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens: (seed * 53) % 20_000,
        costUsd: Math.round(inputTokens * 0.3 + outputTokens * 1.5) / 100_000,
      },
      ...over,
    }),
    toolCalls: 2 + (seed % 46),
  };
};

/**
 * Returns a run's summary, as the run list holds it: the run without its
 * plan, step records, edge counts, subscriptions and failed edge, and with
 * its workflow's name.
 */
export const summarizeRun = (run: Run, workflowName: string): RunSummary => {
  const kept = [
    "id",
    "workflowId",
    "origin",
    "createdAt",
    "status",
    "startedAt",
    "finishedAt",
    "output",
    "failureReason",
    "failedStepId",
    "failureMessage",
  ] as const;
  const summary: Record<string, unknown> = { workflowName };
  for (const key of kept) if (key in run) summary[key] = (run as Record<string, unknown>)[key];
  return summary as RunSummary;
};

/**
 * Returns a run as the workflow list holds it: whether it waits on the user,
 * and the steps it is at, or the step it failed at.
 */
const buildRecentRun = (run: Run, sessions: ReadonlyArray<Session>): RecentRun => {
  const isLive = run.status === "pending" || run.status === "running";
  // A live run is at its running steps; with none running, at the steps
  // waiting to start; with none of those either, at the signals it awaits.
  const running = run.steps.filter((record) => record.status === "running");
  const pending = run.steps.filter((record) => record.status === "pending");
  const liveStepIds = (running.length > 0 ? running : pending).map((record) => record.stepId);
  const awaitedSignals =
    isLive && liveStepIds.length === 0
      ? (run.plan.triggers ?? []).filter((t) => t.kind === "signal").map((t) => t.id)
      : [];
  return {
    id: run.id,
    status: run.status,
    waitingOnUser:
      isLive &&
      sessions.some((session) => session.runId === run.id && session.openRequests.length > 0),
    createdAt: run.createdAt,
    ...("finishedAt" in run ? { finishedAt: run.finishedAt } : {}),
    stepIds:
      run.status === "failed"
        ? "failedStepId" in run && run.failedStepId !== undefined
          ? [run.failedStepId]
          : []
        : isLive
          ? [...new Set(liveStepIds), ...awaitedSignals]
          : [],
  };
};

/** Returns the trigger records of a workflow, as `trigger.query` lists them. */
const buildTriggers = (
  workflowId: string,
  definition: WorkflowDefinition,
  runs: ReadonlyArray<Run>,
  extras: ReadonlyMap<string, Partial<Trigger>>,
): ReadonlyArray<Trigger> =>
  (definition.triggers ?? []).map((trigger) => {
    const lastFired = runs.find(
      (run) => run.origin.kind === "trigger" && run.origin.triggerId === trigger.id,
    );
    const isCron = "schedule" in trigger.on;
    return {
      workflowId,
      workflowName: definition.name,
      triggerId: trigger.id,
      kind: trigger.kind,
      on: trigger.on,
      ...(trigger.kind === "start" ? { status: "active", health: { state: "ok" } } : {}),
      ...(isCron && lastFired !== undefined ? { lastFiredAt: lastFired.createdAt } : {}),
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      ...extras.get(trigger.id),
    };
  });

/** Returns the origin of the `index`th run of a workflow: mostly its first trigger, now and then the user. */
const buildOrigin = (definition: WorkflowDefinition, index: number): RunOrigin => {
  const starts = (definition.triggers ?? []).filter((trigger) => trigger.kind === "start");
  if (starts.length === 0 || index % 7 === 3) return { kind: "manual", actor: "user" };
  return { kind: "trigger", triggerId: starts[index % starts.length]!.id, eventId: 9000 + index };
};

let nextSessionNumber = 1;

/** Builds a chain workflow, its triggers, its runs and their sessions. */
const buildChainWorkflow = (spec: SpecimenWorkflow, workflowNumber: number): BuiltWorkflow => {
  const workflowId = buildId("c", workflowNumber);
  const definition = buildChainDefinition(spec);
  const sessions: Session[] = [];
  const latest = spec.latestMinutesAgo ?? 60;
  const every = spec.everyMinutes ?? DAY;
  const takes = spec.takesMinutes ?? 5;
  const stepCount = spec.steps.length;
  const perStep = takes / stepCount;
  const runs = [...spec.history].map((letter, index): Run => {
    const runId = buildId("d", workflowNumber * 1000 + spec.history.length - index);
    const created = latest + index * every;
    const isLive = letter === "w" || letter === "r";
    const stopIndex =
      letter === "o"
        ? stepCount
        : letter === "x"
          ? 0
          : letter === "f"
            ? spec.steps.findIndex((step) => step.id === (spec.failsAt ?? spec.steps.at(-1)!.id))
            : spec.steps.findIndex((step) => step.id === (spec.liveAt ?? spec.steps[0]!.id));
    const records: StepRecord[] = [];
    for (const [stepIndex, step] of spec.steps.entries()) {
      if (stepIndex > stopIndex) break;
      // A live run is at its step now; its earlier steps took their share of the time.
      const start =
        isLive && stepIndex === stopIndex
          ? Math.max(1, created - stepIndex * perStep)
          : created - stepIndex * perStep;
      const end = Math.max(0, start - perStep);
      let sessionId: string | undefined;
      if ("agent" in step) {
        sessionId = buildId("e", nextSessionNumber++);
        const isRunning = isLive && stepIndex === stopIndex;
        sessions.push(
          buildStepSession(sessionId, spec.name, runId, step.id, AGENTS[step.agent], start, {
            status: isRunning ? "busy" : "idle",
            ...(isRunning && letter === "w" && spec.approve !== undefined
              ? {
                  openRequests: [
                    {
                      requestId: `rq-${runId.slice(-6)}`,
                      itemId: `it-${runId.slice(-6)}`,
                      kind: "command_approval",
                      decisions: ["allow", "deny"],
                      detail: { command: spec.approve },
                    },
                  ],
                }
              : {}),
          }),
        );
      }
      const base = {
        stepId: step.id,
        iteration: 1,
        ...(sessionId === undefined ? {} : { sessionId }),
      };
      if (stepIndex < stopIndex || letter === "o") {
        records.push(buildCompletedRecord(step.id, start, end, null, sessionId));
      } else if (letter === "f") {
        records.push({
          ...base,
          status: "failed",
          startedAt: minutesAgo(start),
          finishedAt: minutesAgo(end),
          error: {
            code: "agent" in step ? "session_failed" : "action_failed",
            message:
              "agent" in step
                ? "The session ended its turn with an error: the provider stopped responding."
                : "The action failed: the remote rejected the push.",
          },
        });
      } else if (letter === "x") {
        records.push({ ...base, status: "cancelled", finishedAt: minutesAgo(start - 1) });
      } else {
        records.push({ ...base, status: "running", startedAt: minutesAgo(start) });
      }
    }
    const edgeTraversals = (definition.edges ?? []).map((edge) =>
      records.some((record) => record.stepId === edge.to) ? 1 : 0,
    );
    const common = {
      id: runId,
      workflowId,
      plan: definition,
      inputs: {},
      origin: buildOrigin(definition, index),
      steps: records,
      edgeTraversals,
      subscriptions: [],
      createdAt: minutesAgo(created),
    };
    const failedStep = spec.steps[stopIndex];
    switch (letter) {
      case "w":
      case "r":
        return { ...common, status: "running", startedAt: minutesAgo(created) };
      case "o":
        return {
          ...common,
          status: "completed",
          startedAt: minutesAgo(created),
          finishedAt: minutesAgo(Math.max(0, created - takes)),
        };
      case "x":
        return {
          ...common,
          status: "cancelled",
          startedAt: minutesAgo(created),
          finishedAt: minutesAgo(created - 1),
        };
      default:
        return {
          ...common,
          status: "failed",
          failureReason:
            failedStep !== undefined && "agent" in failedStep ? "session-failed" : "step-failed",
          failedStepId: failedStep!.id,
          startedAt: minutesAgo(created),
          finishedAt: minutesAgo(Math.max(0, created - (stopIndex + 1) * perStep)),
        };
    }
  });
  const extras = new Map<string, Partial<Trigger>>(
    spec.triggers.map((trigger) => [
      trigger.id,
      "schedule" in trigger
        ? {
            nextFireAt: new Date(SPECIMEN_NOW + trigger.nextInMinutes * 60_000).toISOString(),
            ...(trigger.paused === true ? { status: "paused" as const } : {}),
          }
        : trigger.health === undefined
          ? {}
          : { health: trigger.health },
    ]),
  );
  return assembleWorkflow(workflowId, definition, spec.enabled ?? true, runs, sessions, extras);
};

/** Returns a workflow's records once its runs and sessions are built. */
const assembleWorkflow = (
  workflowId: string,
  definition: WorkflowDefinition,
  enabled: boolean,
  runs: ReadonlyArray<Run>,
  sessions: ReadonlyArray<Session>,
  triggerExtras: ReadonlyMap<string, Partial<Trigger>>,
): BuiltWorkflow => {
  const updatedAt = "2026-09-14T10:20:00.000Z";
  return {
    entry: {
      id: workflowId,
      name: definition.name,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      enabled,
      updatedAt,
      recentRuns: runs.slice(0, RECENT_RUN_LIMIT).map((run) => buildRecentRun(run, sessions)),
    },
    workflow: {
      id: workflowId,
      enabled,
      source: renderWorkflowSource(definition),
      createdAt: CREATED_AT,
      updatedAt,
    },
    definition,
    triggers: buildTriggers(workflowId, definition, runs, triggerExtras),
    runs,
    sessions,
  };
};

/**
 * Builds Ship release and its runs. The four newest are the ones the
 * specimen draws on the graph:
 *
 * - the newest is running: changelog and test are done, the review asked
 *   for changes once, fix made them, the second review approved, and
 *   security waits on the user to approve `npm audit fix --force`, so
 *   open_pr waits on its join;
 * - the one before waits for its pull request to be merged;
 * - the one before that failed: the review asked for changes a fourth time,
 *   past the loop's limit of three;
 * - the one before that completed.
 *
 * The 16 older runs completed, except two that failed at test.
 */
const buildShipRelease = (): BuiltWorkflow => {
  const workflowId = SHIP_RELEASE_ID;
  const plan = SHIP_RELEASE;
  const sessions: Session[] = [];
  const runs: Run[] = [];

  /** Starts a session for `stepId` of run `runId`, `minutes` ago, and returns its id. */
  const startSession = (
    runId: string,
    stepId: string,
    agent: Agent,
    minutes: number,
    over: Partial<Session> = {},
  ): string => {
    const id = buildId("e", nextSessionNumber++);
    sessions.push(buildStepSession(id, plan.name, runId, stepId, agent, minutes, over));
    return id;
  };

  /**
   * Returns the records of a run that prepared a release from `t` minutes
   * ago, with one review that approved, up to and including open_pr.
   */
  const buildPreparedRecords = (runId: string, t: number): StepRecord[] => [
    buildCompletedRecord(
      "changelog",
      t,
      t - 4,
      { changelog: "…" },
      startSession(runId, "changelog", AGENTS.Writer, t),
    ),
    buildCompletedRecord(
      "security",
      t,
      t - 7,
      { findings: 0 },
      startSession(runId, "security", AGENTS.Auditor, t),
    ),
    buildCompletedRecord(
      "test",
      t,
      t - 9,
      { passed: true },
      startSession(runId, "test", AGENTS.Tester, t),
    ),
    buildCompletedRecord(
      "review",
      t,
      t - 6,
      { verdict: "approved" },
      startSession(runId, "review", AGENTS.Reviewer, t),
    ),
    buildCompletedRecord("open_pr", t - 9, t - 10, { number: 4810 }),
  ];

  // The newest run: running, and security waits on the user.
  {
    const runId = buildId("d", 1142);
    const t = 29;
    const reviewSession = startSession(runId, "review", AGENTS.Reviewer, t);
    const steps: StepRecord[] = [
      buildCompletedRecord(
        "changelog",
        t,
        t - 3,
        { changelog: "…" },
        startSession(runId, "changelog", AGENTS.Writer, t),
      ),
      buildCompletedRecord(
        "test",
        t,
        t - 8,
        { passed: true },
        startSession(runId, "test", AGENTS.Tester, t),
      ),
      {
        stepId: "security",
        iteration: 1,
        sessionId: startSession(runId, "security", AGENTS.Auditor, 1, {
          createdAt: minutesAgo(t),
          status: "busy",
          openRequests: [
            {
              requestId: "rq-security",
              itemId: "it-security",
              kind: "command_approval",
              decisions: ["allow", "deny"],
              detail: { command: "npm audit fix --force" },
            },
          ],
        }),
        status: "running",
        startedAt: minutesAgo(t),
      },
      buildCompletedRecord("review", t, t - 5, { verdict: "changes" }, reviewSession),
      buildCompletedRecord(
        "fix",
        t - 5,
        t - 15,
        { commits: 2 },
        startSession(runId, "fix", AGENTS.Coder, t - 5),
      ),
      buildCompletedRecord("review", t - 15, t - 19, { verdict: "approved" }, reviewSession, 2),
      { stepId: "open_pr", iteration: 1, status: "pending" },
    ];
    runs.push({
      id: runId,
      workflowId,
      plan,
      inputs: { version: "2.14.0" },
      origin: { kind: "trigger", triggerId: "release_issue", eventId: 48211 },
      steps,
      edgeTraversals: countShipReleaseEdges({
        [CHANGELOG_PR]: 1,
        [TEST_PR]: 1,
        [REVIEW_PR]: 1,
        [REVIEW_FIX]: 1,
        [FIX_REVIEW]: 1,
      }),
      subscriptions: [],
      createdAt: minutesAgo(t),
      status: "running",
      startedAt: minutesAgo(t),
    });
  }

  // The run before: prepared, and waiting for its pull request to be merged.
  {
    const runId = buildId("d", 1141);
    const t = DAY + 4 * 60;
    runs.push({
      id: runId,
      workflowId,
      plan,
      inputs: { version: "2.13.1" },
      origin: { kind: "manual", actor: "user" },
      steps: buildPreparedRecords(runId, t),
      edgeTraversals: countShipReleaseEdges({
        [CHANGELOG_PR]: 1,
        [TEST_PR]: 1,
        [SECURITY_PR]: 1,
        [REVIEW_PR]: 1,
      }),
      subscriptions: [
        {
          id: buildId("e", 90_001),
          target: { kind: "signal", triggerId: "pr_merged" },
          condition: "event.kind == 'github.pr.merged' && event.payload.number == 4810",
          holder: { kind: "run", id: runId },
          health: { state: "ok" },
          lostWakeUp: null,
          createdAt: minutesAgo(t - 10),
        },
      ],
      createdAt: minutesAgo(t),
      status: "running",
      startedAt: minutesAgo(t),
    });
  }

  // The run before that: the review loop went past its limit.
  {
    const runId = buildId("d", 1140);
    // Friday 25 September, 14:00, when release_train fires.
    const t = 3 * DAY + 19 * 60 + 41;
    const reviewSession = startSession(runId, "review", AGENTS.Reviewer, t);
    const fixSession = startSession(runId, "fix", AGENTS.Coder, t - 4);
    const steps: StepRecord[] = [
      buildCompletedRecord(
        "changelog",
        t,
        t - 4,
        { changelog: "…" },
        startSession(runId, "changelog", AGENTS.Writer, t),
      ),
      buildCompletedRecord(
        "security",
        t,
        t - 6,
        { findings: 0 },
        startSession(runId, "security", AGENTS.Auditor, t),
      ),
      buildCompletedRecord(
        "test",
        t,
        t - 9,
        { passed: true },
        startSession(runId, "test", AGENTS.Tester, t),
      ),
    ];
    for (let round = 0; round < 3; round++) {
      const at = t - round * 12;
      steps.push(
        buildCompletedRecord(
          "review",
          at,
          at - 4,
          { verdict: "changes" },
          reviewSession,
          round + 1,
        ),
      );
      steps.push(
        buildCompletedRecord("fix", at - 4, at - 12, { commits: 1 }, fixSession, round + 1),
      );
    }
    steps.push(
      buildCompletedRecord("review", t - 36, t - 40, { verdict: "changes" }, reviewSession, 4),
    );
    runs.push({
      id: runId,
      workflowId,
      plan,
      inputs: { version: "2.13.0" },
      origin: { kind: "trigger", triggerId: "release_train", eventId: 47390 },
      steps,
      edgeTraversals: countShipReleaseEdges({
        [CHANGELOG_PR]: 1,
        [TEST_PR]: 1,
        [SECURITY_PR]: 1,
        [REVIEW_FIX]: 3,
        [FIX_REVIEW]: 3,
      }),
      subscriptions: [],
      createdAt: minutesAgo(t),
      status: "failed",
      failureReason: "iteration-limit",
      failedStepId: "review",
      failedEdge: {
        index: REVIEW_FIX,
        message: "The run would follow review → fix a fourth time, past its limit of 3.",
      },
      startedAt: minutesAgo(t),
      finishedAt: minutesAgo(t - 40),
    });
  }

  // The run before that, and the 16 older ones: completed, but for two that failed at test.
  for (let index = 3; index < RECENT_RUN_LIMIT; index++) {
    const runId = buildId("d", 1142 - index);
    const t = 4 * DAY + 4 * 60 + 41 + (index - 2) * 3 * DAY + (index % 3) * 70;
    const failsAtTest = index === 7 || index === 15;
    const steps = buildPreparedRecords(runId, t);
    if (failsAtTest) {
      // The test fails after security and the review finished, so open_pr never starts.
      steps.splice(2, 1, {
        stepId: "test",
        iteration: 1,
        sessionId: steps[2]!.sessionId!,
        status: "failed",
        startedAt: minutesAgo(t),
        finishedAt: minutesAgo(t - 11),
        error: {
          code: "session_failed",
          message: "The session ended its turn with an error: 3 end-to-end tests failed.",
        },
      });
      steps.pop();
    } else {
      steps.push(
        {
          stepId: "pr_merged",
          iteration: 1,
          status: "completed",
          startedAt: minutesAgo(t - 80),
          finishedAt: minutesAgo(t - 80),
          output: { number: 4800 - index },
        },
        buildCompletedRecord(
          "announce",
          t - 80,
          t - 83,
          { posted: true },
          startSession(runId, "announce", AGENTS.Writer, t - 80),
        ),
        buildCompletedRecord("notify", t - 83, t - 83, null),
      );
    }
    const common = {
      id: runId,
      workflowId,
      plan: index >= 16 ? SHIP_RELEASE_BEFORE_E2E : plan,
      inputs: { version: `2.${12 - Math.floor(index / 4)}.${index % 4}` },
      // These runs start at any hour, so an issue label starts them, not the Friday schedule.
      origin: { kind: "trigger", triggerId: "release_issue", eventId: 46000 - index } as const,
      steps,
      subscriptions: [],
      createdAt: minutesAgo(t),
    };
    runs.push(
      failsAtTest
        ? {
            ...common,
            edgeTraversals: countShipReleaseEdges({
              [CHANGELOG_PR]: 1,
              [SECURITY_PR]: 1,
              [REVIEW_PR]: 1,
            }),
            status: "failed",
            failureReason: "session-failed",
            failedStepId: "test",
            startedAt: minutesAgo(t),
            finishedAt: minutesAgo(t - 11),
          }
        : {
            ...common,
            edgeTraversals: countShipReleaseEdges({
              [CHANGELOG_PR]: 1,
              [TEST_PR]: 1,
              [SECURITY_PR]: 1,
              [REVIEW_PR]: 1,
              [MERGED_ANNOUNCE]: 1,
              [ANNOUNCE_NOTIFY]: 1,
            }),
            status: "completed",
            startedAt: minutesAgo(t),
            finishedAt: minutesAgo(t - 83),
          },
    );
  }

  // Fridays at 14:00 in Amsterdam: Friday 2 October, 12:00 UTC, is the next.
  const extras = new Map<string, Partial<Trigger>>([
    ["release_train", { nextFireAt: "2026-10-02T14:00:00.000Z" }],
  ]);
  return assembleWorkflow(workflowId, plan, true, runs, sessions, extras);
};

/** One moment of a run, as the specimen that plays a run draws it. */
export interface RunFrame {
  readonly run: Run;
  /** The sessions the run's agent steps had started by that moment. */
  readonly sessions: ReadonlyArray<Session>;
  /** The run as the workflow list shows it at that moment. */
  readonly recentRun: RecentRun;
}

/** The Agent each of Ship release's agent steps runs as. */
const SHIP_RELEASE_STEP_AGENTS: Readonly<Record<string, Agent>> = {
  changelog: AGENTS.Writer,
  security: AGENTS.Auditor,
  test: AGENTS.Tester,
  review: AGENTS.Reviewer,
  fix: AGENTS.Coder,
  announce: AGENTS.Writer,
};

/**
 * Builds Ship release's newest run moment by moment, for the specimen that
 * plays it. Every moment keeps the run's id, so the specimen swaps one
 * moment for the next in the cache:
 *
 * 1. the run starts, and its four entry steps wait for their sessions;
 * 2. the four entry steps run;
 * 3. changelog is done, the review asked for changes, and fix makes them;
 * 4. the second review approved, and security waits on the user to approve
 *    `npm audit fix --force`: the newest run of `WORKFLOWS_RECORDS`.
 *
 * Then, for a run that ends `completed`:
 *
 * 5. security is done, open_pr opened the pull request, and the run waits
 *    for it to be merged;
 * 6. the pull request is merged, and announce runs;
 * 7. notify posted, and the run completed.
 *
 * Or, for a run that ends `failed`:
 *
 * 5. the user denied the command, security's session ended its turn with an
 *    error, and the run failed.
 */
export const buildShipReleaseFrames = (ending: "completed" | "failed"): ReadonlyArray<RunFrame> => {
  const runId = buildId("d", 1142);
  const t = 29;
  const sessionIds = new Map(
    Object.keys(SHIP_RELEASE_STEP_AGENTS).map((stepId, index) => [
      stepId,
      buildId("e", 80_001 + index),
    ]),
  );
  const base = {
    id: runId,
    workflowId: SHIP_RELEASE_ID,
    plan: SHIP_RELEASE,
    inputs: { version: "2.14.0" },
    origin: { kind: "trigger", triggerId: "release_issue", eventId: 48211 },
    subscriptions: [],
    createdAt: minutesAgo(t),
    startedAt: minutesAgo(t),
  } as const;
  const buildLiveRun = (
    steps: ReadonlyArray<StepRecord>,
    followed: Partial<Record<number, number>>,
    subscriptions: Run["subscriptions"] = [],
  ): Run => ({
    ...base,
    steps,
    edgeTraversals: countShipReleaseEdges(followed),
    subscriptions,
    status: "running",
  });
  const pending = (stepId: string): StepRecord => ({ stepId, iteration: 1, status: "pending" });
  const running = (stepId: string, start: number, iteration = 1): StepRecord => ({
    stepId,
    iteration,
    sessionId: sessionIds.get(stepId)!,
    status: "running",
    startedAt: minutesAgo(start),
  });
  const completed = (
    stepId: string,
    start: number,
    end: number,
    output: Extract<StepRecord, { status: "completed" }>["output"],
    iteration = 1,
  ): StepRecord =>
    buildCompletedRecord(stepId, start, end, output, sessionIds.get(stepId), iteration);

  const changelog = completed("changelog", t, 26, { changelog: "…" });
  const test = completed("test", t, 21, { passed: true });
  const firstReview = completed("review", t, 24, { verdict: "changes" });
  const fix = completed("fix", 24, 14, { commits: 2 });
  const secondReview = completed("review", 14, 10, { verdict: "approved" }, 2);
  const prepared = {
    [CHANGELOG_PR]: 1,
    [TEST_PR]: 1,
    [REVIEW_FIX]: 1,
    [FIX_REVIEW]: 1,
    [REVIEW_PR]: 1,
  };
  const shared: ReadonlyArray<readonly [Run, boolean]> = [
    [buildLiveRun(["changelog", "security", "test", "review"].map(pending), {}), false],
    [
      buildLiveRun(
        ["changelog", "security", "test", "review"].map((stepId) => running(stepId, t)),
        {},
      ),
      false,
    ],
    [
      buildLiveRun(
        [changelog, running("security", t), running("test", t), firstReview, running("fix", 24)],
        { [CHANGELOG_PR]: 1, [REVIEW_FIX]: 1 },
      ),
      false,
    ],
    [
      buildLiveRun(
        [
          changelog,
          running("security", t),
          test,
          firstReview,
          fix,
          secondReview,
          pending("open_pr"),
        ],
        prepared,
      ),
      true,
    ],
  ];
  const securityDone = completed("security", t, 6, { findings: 1 });
  const openPr = buildCompletedRecord("open_pr", 6, 6, { number: 4812 });
  const mergedPr: StepRecord = {
    stepId: "pr_merged",
    iteration: 1,
    status: "completed",
    startedAt: minutesAgo(3),
    finishedAt: minutesAgo(3),
    output: { number: 4812 },
  };
  const afterSecurity = [changelog, securityDone, test, firstReview, fix, secondReview, openPr];
  const ended: ReadonlyArray<readonly [Run, boolean]> =
    ending === "completed"
      ? [
          [
            buildLiveRun(afterSecurity, { ...prepared, [SECURITY_PR]: 1 }, [
              {
                id: buildId("e", 90_002),
                target: { kind: "signal", triggerId: "pr_merged" },
                condition: "event.kind == 'github.pr.merged' && event.payload.number == 4812",
                holder: { kind: "run", id: runId },
                health: { state: "ok" },
                lostWakeUp: null,
                createdAt: minutesAgo(6),
              },
            ]),
            false,
          ],
          [
            buildLiveRun([...afterSecurity, mergedPr, running("announce", 3)], {
              ...prepared,
              [SECURITY_PR]: 1,
              [MERGED_ANNOUNCE]: 1,
            }),
            false,
          ],
          [
            {
              ...base,
              steps: [
                ...afterSecurity,
                mergedPr,
                completed("announce", 3, 1, { posted: true }),
                buildCompletedRecord("notify", 1, 0, null),
              ],
              edgeTraversals: countShipReleaseEdges({
                ...prepared,
                [SECURITY_PR]: 1,
                [MERGED_ANNOUNCE]: 1,
                [ANNOUNCE_NOTIFY]: 1,
              }),
              status: "completed",
              finishedAt: minutesAgo(0),
            },
            false,
          ],
        ]
      : [
          [
            {
              ...base,
              steps: [
                changelog,
                {
                  stepId: "security",
                  iteration: 1,
                  sessionId: sessionIds.get("security")!,
                  status: "failed",
                  startedAt: minutesAgo(t),
                  finishedAt: minutesAgo(6),
                  error: {
                    code: "session_failed",
                    message: "The session ended its turn with an error: the command was denied.",
                  },
                },
                test,
                firstReview,
                fix,
                secondReview,
                { stepId: "open_pr", iteration: 1, status: "cancelled", finishedAt: minutesAgo(6) },
              ],
              edgeTraversals: countShipReleaseEdges(prepared),
              status: "failed",
              failureReason: "session-failed",
              failedStepId: "security",
              finishedAt: minutesAgo(6),
            },
            false,
          ],
        ];

  return [...shared, ...ended].map(([run, asksUser]) => {
    // A session is busy while one of its step's records runs. Security's
    // session asks the user to approve a command in the moment that waits on them.
    const sessions = [...sessionIds].flatMap(([stepId, id]) =>
      run.steps.some((record) => record.sessionId === id)
        ? [
            buildStepSession(
              id,
              SHIP_RELEASE.name,
              runId,
              stepId,
              SHIP_RELEASE_STEP_AGENTS[stepId]!,
              t,
              {
                status: run.steps.some(
                  (record) => record.sessionId === id && record.status === "running",
                )
                  ? "busy"
                  : "idle",
                ...(asksUser && stepId === "security"
                  ? {
                      openRequests: [
                        {
                          requestId: "rq-security",
                          itemId: "it-security",
                          kind: "command_approval",
                          decisions: ["allow", "deny"],
                          detail: { command: "npm audit fix --force" },
                        },
                      ],
                    }
                  : {}),
              },
            ),
          ]
        : [],
    );
    return { run, sessions, recentRun: buildRecentRun(run, sessions) };
  });
};

const BUILT: ReadonlyArray<BuiltWorkflow> = [
  buildShipRelease(),
  ...CHAIN_WORKFLOWS.map((spec, index) => buildChainWorkflow(spec, index + 2)),
].toSorted((a, b) => a.entry.name.localeCompare(b.entry.name));

/** Everything the Workflows screen reads, as the controller returns it. */
export interface WorkflowsRecords {
  /** The workflow list, by name, as `workflow.query` would return it with `recentRuns`. */
  readonly workflows: ReadonlyArray<WorkflowListEntry>;
  /** Each workflow as `workflow.read` would return it, with its definition. */
  readonly storedWorkflows: ReadonlyArray<StoredWorkflow>;
  /** Every trigger of every workflow. */
  readonly triggers: ReadonlyArray<Trigger>;
  /** Every run of every workflow, newest first within each workflow. */
  readonly runs: ReadonlyArray<Run>;
  /** The run summaries of each workflow, newest first, as one page of `run.query` holds them. */
  readonly runSummaries: ReadonlyMap<string, ReadonlyArray<RunSummary>>;
  /** Every session a run's agent step started. */
  readonly runSessions: ReadonlyArray<Session>;
  readonly agents: ReadonlyArray<Agent>;
  readonly workflowActions: ReadonlyArray<WorkflowAction>;
}

export const WORKFLOWS_RECORDS: WorkflowsRecords = {
  workflows: BUILT.map(({ entry }) => entry),
  storedWorkflows: BUILT.map(({ workflow, definition }) => ({ workflow, definition })),
  triggers: BUILT.flatMap(({ triggers }) => triggers),
  runs: BUILT.flatMap(({ runs }) => runs),
  runSummaries: new Map(
    BUILT.map(({ entry, runs }) => [entry.id, runs.map((run) => summarizeRun(run, entry.name))]),
  ),
  runSessions: BUILT.flatMap(({ sessions }) => sessions),
  agents: Object.values(AGENTS),
  workflowActions: WORKFLOW_ACTIONS,
};
