/**
 * The records of the sidebar rows specimen (sidebar-rows.tsx): the four rows
 * the Workbench, refined drawing shows in `?state=rows`, which draw its
 * rule for the dots at 1, 2, 3 and 10 Threads, and the Threads behind them.
 *
 * Each row sits under a project of its own, so that every row has a project
 * heading, where the drawing puts a caption over each row. The Threads run on
 * the sidebar specimen's runner and models (sidebar-fixture.ts), and the
 * Threads of one row share a worktree, which is what makes them one row.
 */
import type { Project, Session } from "@hercule/contract";
import {
  buildCheckout,
  buildProject,
  buildRepo,
  buildWorkspace,
} from "@hercule/client-core/threads/testing";
import {
  buildSpecimenSession,
  CLAUDE_OPUS,
  CLAUDE_SONNET,
  GPT,
  SPECIMEN_INSTANCES,
  SPECIMEN_NOW,
  STUDIO_MAC,
  type SpecimenModel,
} from "./sidebar-fixture";
import type { SidebarRecords } from "./shell-page";

/**
 * The four projects, one per row, in the order the sidebar lists them: by
 * when each project's newest group started, newest first.
 */
const ROW_PROJECTS: ReadonlyArray<Project> = [
  buildProject("p-reporting", "reporting"),
  buildProject("p-webshop", "webshop"),
  buildProject("p-payments-api", "payments-api"),
  buildProject("p-billing", "billing"),
];

/** The session the specimen opens: the lead of the group of ten, whose row the drawing marks as open. */
export const OPEN_SESSION_ID = "s-result-lead";

const PAYMENTS_REPO = buildRepo(
  "res-payments-api",
  "git@github.com:acme/payments-api.git",
  "github.com/acme/payments-api",
  ["p-payments-api", "p-reporting", "p-billing"],
);

const WEBSHOP_REPO = buildRepo(
  "res-webshop",
  "git@github.com:acme/webshop.git",
  "github.com/acme/webshop",
  ["p-webshop"],
);

/** Returns a worktree on `branch` of `repo`, on studio-mac, where a group's sessions work. */
const buildWorktree = (id: string, repo: typeof PAYMENTS_REPO, branch: string) =>
  buildWorkspace({
    id,
    runnerId: STUDIO_MAC.id,
    kind: "ephemeral",
    checkouts: [{ ...buildCheckout(repo.id, branch), form: "worktree" }],
    sessionIds: [],
  });

const PAYOUT_WORKSPACE = buildWorktree("ws-payout", PAYMENTS_REPO, "rogier/payout-report");
const THREE_DS_WORKSPACE = buildWorktree("ws-3ds", WEBSHOP_REPO, "fix/3ds-eu-cards");
const RESULT_WORKSPACE = buildWorktree("ws-result", PAYMENTS_REPO, "rogier/result-error-shape");

/**
 * Returns a Thread that started `startedAgo` minutes and was last active
 * `lastAgo` minutes before `SPECIMEN_NOW`. The oldest Thread of a worktree is
 * its group's lead, so a lead is given the earliest start.
 */
const buildRowSession = ({
  startedAgo,
  lastAgo,
  ...session
}: Omit<Parameters<typeof buildSpecimenSession>[0], "minutesAgo"> & {
  readonly startedAgo: number;
  readonly lastAgo: number;
}): Session =>
  buildSpecimenSession({
    ...session,
    minutesAgo: lastAgo,
    createdAt: new Date(SPECIMEN_NOW - startedAgo * 60_000).toISOString(),
  });

/** Returns the request of a session that asks `question`, in the agent's own words. */
const buildQuestionRequest = (id: string, question: string): Session["openRequests"][number] => ({
  requestId: `rq-${id}`,
  itemId: `it-${id}`,
  kind: "question",
  detail: {
    questions: [
      {
        question,
        header: "Question",
        options: [
          { label: "Yes", description: "Take the first reading." },
          { label: "No", description: "Take the second reading." },
        ],
        multiSelect: false,
      },
    ],
  },
});

/** A lone Thread: it is idle, and was last active an hour ago. */
const LONE_THREAD: ReadonlyArray<Session> = [
  buildRowSession({
    id: "s-ideal-research",
    title: "Add iDEAL research",
    projectId: "p-payments-api",
    status: "idle",
    startedAgo: 71,
    lastAgo: 60,
    model: GPT,
  }),
];

/** A group of two: the lead works, and its partner "check" asks a question. */
const PAIR: ReadonlyArray<Session> = [
  buildRowSession({
    id: "s-payout-lead",
    title: "Payout report for September",
    projectId: "p-reporting",
    workspaceId: PAYOUT_WORKSPACE.id,
    status: "busy",
    startedAgo: 9,
    lastAgo: 0,
    model: GPT,
  }),
  buildRowSession({
    id: "s-payout-check",
    title: "Check payout totals against Stripe",
    role: "check",
    projectId: "p-reporting",
    workspaceId: PAYOUT_WORKSPACE.id,
    status: "busy",
    startedAgo: 6,
    lastAgo: 2,
    model: CLAUDE_SONNET,
    openRequests: [buildQuestionRequest("payout-check", "Settlement or payout date?")],
  }),
];

/** A group of three: the lead waits on an approval, "research" is idle and "review" works. */
const TRIO: ReadonlyArray<Session> = [
  buildRowSession({
    id: "s-3ds-lead",
    title: "Fix 3-D Secure checkout for EU cards",
    projectId: "p-webshop",
    workspaceId: THREE_DS_WORKSPACE.id,
    status: "busy",
    startedAgo: 39,
    lastAgo: 10,
    model: CLAUDE_OPUS,
    openRequests: [
      {
        requestId: "rq-3ds-lead",
        itemId: "it-3ds-lead",
        kind: "command_approval",
        decisions: ["allow", "deny"],
        detail: { command: "git push" },
      },
    ],
  }),
  buildRowSession({
    id: "s-3ds-research",
    title: "Read the Stripe v14 changelog",
    role: "research",
    projectId: "p-webshop",
    workspaceId: THREE_DS_WORKSPACE.id,
    status: "idle",
    startedAgo: 36,
    lastAgo: 20,
    model: CLAUDE_SONNET,
  }),
  buildRowSession({
    id: "s-3ds-review",
    title: "Adversarial review of the 3-D Secure fix",
    role: "review",
    projectId: "p-webshop",
    workspaceId: THREE_DS_WORKSPACE.id,
    status: "busy",
    startedAgo: 11,
    lastAgo: 0,
    model: GPT,
  }),
];

/**
 * The idle partners of the group of ten: role (or `null` for a partner the
 * user added without one), title, minutes since it started, minutes since it
 * was last active, and model.
 */
const IDLE_PARTNERS: ReadonlyArray<
  readonly [string | null, string, number, number, SpecimenModel]
> = [
  [
    "inventory",
    "Find every payout endpoint that still returns a raw IActionResult",
    86,
    70,
    CLAUDE_SONNET,
  ],
  ["mobile check", "Check that the mobile app still parses payout errors", 39, 17, GPT],
  ["benchmark", "Benchmark payout list latency before and after the migration", 43, 30, GPT],
  ["refunds review", "Second adversarial pass on refunds and reversals", 36, 8, CLAUDE_OPUS],
  [
    null,
    "Draft the changelog entry and the migration note for API consumers",
    15,
    11,
    CLAUDE_SONNET,
  ],
  [
    null,
    "Ask whether Stripe can send payout.failed twice for the same payout",
    27,
    22,
    CLAUDE_SONNET,
  ],
];

/**
 * A group of ten: the lead and the partners "tests" and "API docs" work,
 * "review" asks a question, and six partners are idle. Folded, it shows
 * three dots and "+7".
 */
const CREW_OF_TEN: ReadonlyArray<Session> = [
  buildRowSession({
    id: OPEN_SESSION_ID,
    title: "Migrate the unmigrated payout endpoints to the Result error shape",
    projectId: "p-billing",
    workspaceId: RESULT_WORKSPACE.id,
    status: "busy",
    startedAgo: 89,
    lastAgo: 0,
    model: CLAUDE_OPUS,
  }),
  buildRowSession({
    id: "s-result-review",
    title: "Adversarial review of the Result error shape",
    role: "review",
    projectId: "p-billing",
    workspaceId: RESULT_WORKSPACE.id,
    status: "busy",
    startedAgo: 61,
    lastAgo: 4,
    model: GPT,
    openRequests: [buildQuestionRequest("result-review", "409 from Stripe: error or retry?")],
  }),
  buildRowSession({
    id: "s-result-tests",
    title: "Write contract tests for every migrated payout endpoint",
    role: "tests",
    projectId: "p-billing",
    workspaceId: RESULT_WORKSPACE.id,
    status: "busy",
    startedAgo: 57,
    lastAgo: 1,
    model: GPT,
  }),
  buildRowSession({
    id: "s-result-docs",
    title: "Update the OpenAPI document for the new Result error responses",
    role: "API docs",
    projectId: "p-billing",
    workspaceId: RESULT_WORKSPACE.id,
    status: "busy",
    startedAgo: 21,
    lastAgo: 0,
    model: CLAUDE_SONNET,
  }),
  ...IDLE_PARTNERS.map(([role, title, startedAgo, lastAgo, model], index) =>
    buildRowSession({
      id: `s-result-idle-${String(index)}`,
      title,
      role,
      projectId: "p-billing",
      workspaceId: RESULT_WORKSPACE.id,
      status: "idle",
      startedAgo,
      lastAgo,
      model,
    }),
  ),
];

/** Every list the sidebar reads: the four rows' Threads, their projects, workspaces and runner. */
export const ROWS_RECORDS: SidebarRecords = {
  threads: [...LONE_THREAD, ...PAIR, ...TRIO, ...CREW_OF_TEN],
  assistants: [],
  projects: ROW_PROJECTS,
  workspaces: [PAYOUT_WORKSPACE, THREE_DS_WORKSPACE, RESULT_WORKSPACE],
  resources: [PAYMENTS_REPO, WEBSHOP_REPO],
  runners: [STUDIO_MAC],
  instances: SPECIMEN_INSTANCES,
  user: { username: "Rogier" },
};
