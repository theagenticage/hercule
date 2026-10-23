/**
 * The records of the sidebar states specimen (sidebar-states.tsx): eleven
 * scenes that draw the sidebar states the Bureau book never draws, for a
 * check by eye. `node scripts/capture-sidebar-states.ts` captures each scene
 * in both themes.
 *
 * Every thread row is 52px tall, so each scene holds only as many rows as
 * fit the capture's window. The threads of one workspace are one row, so
 * scenes 1 to 5 give each thread a workspace of its own, or none, to draw
 * rows of a single thread; scenes 6 to 11 draw groups.
 *
 * - Scene 1 has an open thread and three projects:
 *   - webshop, whose threads work in a worktree, in the main workspace and in
 *     no workspace, so the rows' second lines show each kind: the machine,
 *     because the worktree's branch was generated, the branch `main`, and
 *     "No workspace". The open thread is in the worktree, and the composer
 *     of "Tidy product image alt text" holds an unsent message, so its row
 *     is tinted;
 *   - ops, whose three threads each end their row differently: "Queued",
 *     "Offline", and the age of an ended thread. An asleep thread, or one
 *     the crash-loop guard holds, ends its row with its age too, so the
 *     scene leaves them out to fit the capture's window;
 *   - a project with a very long name, whose thread's title is too long for
 *     the sidebar.
 * - Scene 2 has the thread in no project open. Four threads wait on the
 *   user, so Waiting on you shows three and a "more" row; payments-api has
 *   seven threads, so it shows five, "3 need you" and a "more" row; and one
 *   thread belongs to no project.
 * - Scene 3 is scene 2 without the threads in no project, and with
 *   payments-api's "more" row pressed, so the project shows every thread.
 *   One of payments-api's threads is open, so no draft's row takes the
 *   space the expanded project needs.
 * - Scene 4 is scene 2 on the Hercule face, with a GitHub Connection whose
 *   last check failed, so the Connections row ends in the red dot.
 * - Scene 5 has the Done shelf open, with four threads marked Done, most
 *   recently marked first. One of them still waits on an approval, so it is
 *   also in Waiting on you. webshop keeps a working thread, which recedes, an
 *   idle one and one that asks a question.
 *
 * - Scene 6 is a morning: a lead whose partner "review" asks a question, so
 *   the row's second line and Waiting on you both name the asker, beside
 *   rows of a single thread.
 * - Scene 7 is a group of three, unfolded, with the lead open.
 * - Scene 8 is a group of ten, folded: three dots and "+7". Scene 9 is the
 *   same group unfolded: the four sessions that wait or work, and "6 quiet".
 * - Scene 10 has the Done shelf open, with a group of three Threads that was
 *   marked Done together.
 * - Scene 11 is scene 8 with the card of the group of ten on show.
 *
 * The threads run on the sidebar specimen's runner and models
 * (sidebar-fixture.ts), except the one on build-box, a runner that is
 * offline.
 */
import type { Project, Runner, Session } from "@hercule/contract";
import {
  buildCheckout,
  buildProject,
  buildRepo,
  buildRunner,
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
import type { SidebarFace } from "../shell/sidebar-face";
import { FAILED_CONNECTION } from "./settings-assistants-fixture";
import type { SidebarRecords } from "./shell-page";

/** A runner that has gone offline. Its thread's row ends in "offline". */
const BUILD_BOX: Runner = { ...buildRunner("r-build-box", "build-box"), connectivity: "offline" };

const LONG_PROJECT_NAME = "customer-onboarding-and-kyc-verification";

/**
 * The projects, in the order the controller lists them. A project's tint
 * follows its place in this list: webshop, payments-api and ops get the
 * book's three tints, and the fourth project starts again at the first.
 */
const PROJECTS: ReadonlyArray<Project> = [
  buildProject("p-webshop", "webshop"),
  buildProject("p-payments-api", "payments-api"),
  buildProject("p-ops", "ops"),
  buildProject("p-onboarding", LONG_PROJECT_NAME),
];

const WEBSHOP_REPO = buildRepo(
  "res-webshop",
  "git@github.com:acme/webshop.git",
  "github.com/acme/webshop",
  ["p-webshop"],
);

const ONBOARDING_REPO = buildRepo(
  "res-onboarding",
  `git@github.com:acme/${LONG_PROJECT_NAME}.git`,
  `github.com/acme/${LONG_PROJECT_NAME}`,
  ["p-onboarding"],
);

/** The ids of scene 1's threads that work in a workspace, which each workspace lists. */
const THREAD_IDS = {
  flakyTest: "s-flaky-test",
  applePay: "s-apple-pay",
  stripeBump: "s-stripe-bump",
  altText: "s-alt-text",
  proxy502: "s-proxy-502",
} as const;

/**
 * Returns a worktree of `repo` on a branch of its own, on studio-mac, for the
 * sessions `sessionIds`.
 */
const buildWorktree = (
  id: string,
  repo: typeof WEBSHOP_REPO,
  branch: string,
  sessionIds: readonly string[],
) =>
  buildWorkspace({
    id,
    runnerId: STUDIO_MAC.id,
    kind: "ephemeral",
    checkouts: [{ ...buildCheckout(repo.id, branch), form: "worktree" }],
    sessionIds: [...sessionIds],
  });

/**
 * The workspaces of scenes 1 to 5: a worktree of webshop for each of two
 * threads, the main workspaces of webshop and of the long-named project, and
 * a worktree of each group of scenes 6 to 11. All on studio-mac. Each of
 * scene 1's threads has a workspace of its own, because the threads of one
 * workspace are one row.
 */
const WORKSPACES = [
  buildWorktree("ws-thread-3f1", WEBSHOP_REPO, "hercule/thread-3f1", [THREAD_IDS.flakyTest]),
  buildWorktree("ws-thread-9d2", WEBSHOP_REPO, "hercule/thread-9d2", [THREAD_IDS.applePay]),
  buildWorkspace({
    id: "ws-webshop-main",
    runnerId: STUDIO_MAC.id,
    kind: "primary",
    checkouts: [buildCheckout(WEBSHOP_REPO.id, "main", ["main", "hercule/thread-3f1"])],
    sessionIds: [THREAD_IDS.stripeBump],
  }),
  buildWorkspace({
    id: "ws-onboarding-main",
    runnerId: STUDIO_MAC.id,
    kind: "primary",
    checkouts: [buildCheckout(ONBOARDING_REPO.id, "main")],
    sessionIds: [THREAD_IDS.proxy502],
  }),
];

/** Returns the moment `minutes` minutes before `SPECIMEN_NOW`, as the API spells a time. */
const buildTimeBefore = (minutes: number): string =>
  new Date(SPECIMEN_NOW - minutes * 60_000).toISOString();

/**
 * Scene 1's threads. Each was created when it was last active.
 *
 * webshop has four threads and the long-named project one, so the eight
 * 52px rows fit the capture's window.
 */
const SCENE_1_THREADS: ReadonlyArray<Session> = [
  buildSpecimenSession({
    id: THREAD_IDS.flakyTest,
    title: "Fix the flaky checkout e2e test",
    projectId: "p-webshop",
    workspaceId: "ws-thread-3f1",
    status: "busy",
    minutesAgo: 3,
    model: CLAUDE_SONNET,
  }),
  buildSpecimenSession({
    id: THREAD_IDS.applePay,
    title: "Add Apple Pay to express checkout",
    projectId: "p-webshop",
    workspaceId: "ws-thread-9d2",
    status: "idle",
    minutesAgo: 180,
    model: GPT,
  }),
  buildSpecimenSession({
    id: THREAD_IDS.stripeBump,
    title: "Bump the Stripe SDK to v14",
    projectId: "p-webshop",
    workspaceId: "ws-webshop-main",
    status: "busy",
    minutesAgo: 9,
    model: CLAUDE_SONNET,
  }),
  buildSpecimenSession({
    id: THREAD_IDS.altText,
    title: "Tidy product image alt text",
    projectId: "p-webshop",
    status: "idle",
    minutesAgo: 40,
    model: CLAUDE_SONNET,
  }),
  // ops: one thread for each way a row can end other than a mark.
  buildSpecimenSession({
    id: "s-metrics-rebuild",
    title: "Rebuild the metrics dashboard",
    projectId: "p-ops",
    // studio-mac is online but running as many sessions as it may.
    status: "queued",
    minutesAgo: 6,
    model: CLAUDE_SONNET,
  }),
  buildSpecimenSession({
    id: "s-rotate-secrets",
    title: "Rotate staging secrets",
    projectId: "p-ops",
    runnerId: BUILD_BOX.id,
    status: "idle",
    minutesAgo: 25,
    model: CLAUDE_SONNET,
  }),
  buildSpecimenSession({
    id: "s-iam-audit",
    title: "Audit IAM roles",
    projectId: "p-ops",
    // Over: it cannot be resumed.
    status: "exited",
    exitedAt: buildTimeBefore(2 * 24 * 60),
    minutesAgo: 2 * 24 * 60,
    model: CLAUDE_SONNET,
  }),
  buildSpecimenSession({
    id: THREAD_IDS.proxy502,
    title: "Investigate intermittent 502s from the image resizing proxy under load",
    projectId: "p-onboarding",
    workspaceId: "ws-onboarding-main",
    status: "idle",
    minutesAgo: 15,
    model: GPT,
  }),
];

/**
 * payments-api's seven threads, in no workspace: three waiting, two working
 * and two that are neither. Capped, it shows the waiting and the working
 * ones, and "2 more".
 */
const PAYMENTS_THREADS: ReadonlyArray<Session> = [
  buildSpecimenSession({
    id: "s-payout-report",
    title: "Payout report for September",
    projectId: "p-payments-api",
    status: "busy",
    minutesAgo: 1,
    model: GPT,
    openRequests: [
      {
        requestId: "rq-payout-report",
        itemId: "it-payout-report",
        kind: "command_approval",
        decisions: ["allow", "deny"],
        detail: { command: "pnpm run payouts:dry-run --month 2026-09" },
      },
    ],
  }),
  buildSpecimenSession({
    id: "s-refund-webhooks",
    title: "Refactor refund webhooks",
    projectId: "p-payments-api",
    status: "busy",
    minutesAgo: 2,
    model: CLAUDE_SONNET,
  }),
  buildSpecimenSession({
    id: "s-adyen-reconcile",
    title: "Reconcile Adyen settlement files",
    projectId: "p-payments-api",
    status: "busy",
    minutesAgo: 4,
    model: CLAUDE_SONNET,
    openRequests: [
      {
        requestId: "rq-adyen-reconcile",
        itemId: "it-adyen-reconcile",
        kind: "file_change_approval",
        decisions: ["allow", "deny"],
        detail: { paths: ["src/reconcile/adyen.ts"] },
      },
    ],
  }),
  buildSpecimenSession({
    id: "s-invoice-backfill",
    title: "Backfill missing invoice numbers",
    projectId: "p-payments-api",
    status: "busy",
    minutesAgo: 7,
    model: GPT,
  }),
  buildSpecimenSession({
    id: "s-ideal-research",
    title: "Add iDEAL research",
    projectId: "p-payments-api",
    status: "busy",
    minutesAgo: 11,
    model: GPT,
    openRequests: [
      {
        requestId: "rq-ideal-research",
        itemId: "it-ideal-research",
        kind: "question",
        detail: {
          questions: [
            {
              question: "Which iDEAL issuers should the sandbox list?",
              header: "Issuers",
              options: [
                { label: "All of them", description: "Every issuer the iDEAL directory lists." },
                { label: "The five largest", description: "ING, Rabobank, ABN AMRO, SNS and ASN." },
              ],
              multiSelect: false,
            },
          ],
        },
      },
    ],
  }),
  buildSpecimenSession({
    id: "s-psd3-draft",
    title: "Read the PSD3 draft",
    projectId: "p-payments-api",
    status: "idle",
    minutesAgo: 20,
    model: CLAUDE_SONNET,
  }),
  buildSpecimenSession({
    id: "s-ledger-split",
    title: "Split the ledger service",
    projectId: "p-payments-api",
    status: "exited",
    resumable: true,
    exitedAt: buildTimeBefore(26 * 60),
    minutesAgo: 26 * 60,
    model: CLAUDE_SONNET,
  }),
];

/**
 * Scene 2's threads: payments-api's, and one in no project, waiting.
 * Waiting on you counts all five waiting threads, shows the three newest,
 * and "2 more waiting on you".
 */
const SCENE_2_THREADS: ReadonlyArray<Session> = [
  ...PAYMENTS_THREADS,
  buildSpecimenSession({
    id: "s-playwright-flake",
    title: "Explain the flaky Playwright run",
    status: "busy",
    minutesAgo: 3,
    model: CLAUDE_SONNET,
    openRequests: [
      {
        requestId: "rq-playwright-flake",
        itemId: "it-playwright-flake",
        kind: "tool_approval",
        decisions: ["allow", "deny"],
        detail: { toolName: "WebFetch" },
      },
    ],
  }),
];

/** The approval "Reconcile Adyen settlement files" waits on. */
const ADYEN_APPROVAL = PAYMENTS_THREADS.find((session) => session.id === "s-adyen-reconcile")!
  .openRequests[0]!;

/** Returns `session` marked Done by the user `minutes` minutes before `SPECIMEN_NOW`. */
const markDoneBefore = (session: Session, minutes: number): Session => ({
  ...session,
  done: { at: buildTimeBefore(minutes), by: "user" },
});

/**
 * Scene 5's threads: three open in webshop, and four marked Done, listed out
 * of the order the shelf sorts them in.
 */
const SCENE_5_THREADS: ReadonlyArray<Session> = [
  buildSpecimenSession({
    id: THREAD_IDS.flakyTest,
    title: "Fix the flaky checkout e2e test",
    projectId: "p-webshop",
    workspaceId: "ws-thread-3f1",
    status: "busy",
    minutesAgo: 3,
    model: CLAUDE_SONNET,
  }),
  buildSpecimenSession({
    id: THREAD_IDS.altText,
    title: "Tidy product image alt text",
    projectId: "p-webshop",
    status: "idle",
    minutesAgo: 40,
    model: CLAUDE_SONNET,
  }),
  buildSpecimenSession({
    id: "s-sizes-question",
    title: "Pick the image sizes for the CDN",
    projectId: "p-webshop",
    status: "busy",
    minutesAgo: 12,
    model: GPT,
    openRequests: [
      {
        requestId: "rq-sizes-question",
        itemId: "it-sizes-question",
        kind: "question",
        detail: {
          questions: [
            {
              question: "Which widths should the CDN render?",
              header: "Widths",
              options: [
                { label: "320, 640 and 1280", description: "The widths the theme asks for today." },
                {
                  label: "Every 160px to 1920",
                  description: "One width per step, for any layout.",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      },
    ],
  }),
  markDoneBefore(
    buildSpecimenSession({
      id: THREAD_IDS.applePay,
      title: "Add Apple Pay to express checkout",
      projectId: "p-webshop",
      workspaceId: "ws-thread-9d2",
      status: "idle",
      minutesAgo: 300,
      model: GPT,
    }),
    180,
  ),
  markDoneBefore(
    buildSpecimenSession({
      id: THREAD_IDS.stripeBump,
      title: "Bump the Stripe SDK to v14",
      projectId: "p-webshop",
      workspaceId: "ws-webshop-main",
      status: "idle",
      minutesAgo: 90,
      model: CLAUDE_SONNET,
    }),
    20,
  ),
  markDoneBefore(
    buildSpecimenSession({
      id: "s-iam-audit",
      title: "Audit IAM roles",
      projectId: "p-ops",
      status: "exited",
      exitedAt: buildTimeBefore(3 * 24 * 60),
      minutesAgo: 3 * 24 * 60,
      model: CLAUDE_SONNET,
    }),
    2 * 24 * 60,
  ),
  markDoneBefore(
    buildSpecimenSession({
      id: "s-adyen-reconcile",
      title: "Reconcile Adyen settlement files",
      projectId: "p-payments-api",
      status: "busy",
      minutesAgo: 30,
      model: CLAUDE_SONNET,
      openRequests: [ADYEN_APPROVAL],
    }),
    45,
  ),
];

/** The request a session waits on when it asks `question`, in the agent's own words. */
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
          { label: "Return the error", description: "Pass the failure to the caller." },
          { label: "Retry once", description: "Try the request again, then fail." },
        ],
        multiSelect: false,
      },
    ],
  },
});

/** The worktree where the group of scenes 6, 8, 9 and 11 works. */
const RESULT_WORKSPACE = buildWorktree("ws-result", WEBSHOP_REPO, "rogier/result-error-shape", []);

/**
 * The lead and the partner of scene 6, whose partner "review" asks a
 * question: two sessions in one workspace. The lead was created first.
 */
const RESULT_PAIR: ReadonlyArray<Session> = [
  buildSpecimenSession({
    id: "s-result-lead",
    title: "Migrate the unmigrated payout endpoints to the Result error shape",
    projectId: "p-payments-api",
    workspaceId: RESULT_WORKSPACE.id,
    status: "busy",
    minutesAgo: 95,
    model: CLAUDE_OPUS,
  }),
  buildSpecimenSession({
    id: "s-result-review",
    title: "Review the Result migration",
    role: "review",
    projectId: "p-payments-api",
    workspaceId: RESULT_WORKSPACE.id,
    status: "busy",
    minutesAgo: 4,
    model: GPT,
    openRequests: [buildQuestionRequest("result-review", "409 from Stripe: error or retry?")],
  }),
];

/** An idle thread in payments-api, in scenes 6 and 8. */
const IDEAL_NOTES = buildSpecimenSession({
  id: "s-ideal-notes",
  title: "Add iDEAL research",
  projectId: "p-payments-api",
  status: "idle",
  minutesAgo: 180,
  model: GPT,
});

/** A working thread in ops, in scenes 6 and 8. */
const ROTATE_STAGING = buildSpecimenSession({
  id: "s-rotate-staging",
  title: "Rotate staging secrets",
  projectId: "p-ops",
  status: "busy",
  minutesAgo: 14,
  model: CLAUDE_SONNET,
});

/**
 * Scene 6's rows of a single thread: a working one and an idle one in
 * payments-api, one in ops and one in webshop.
 */
const SCENE_6_SINGLES: ReadonlyArray<Session> = [
  buildSpecimenSession({
    id: "s-invoice-numbers",
    title: "Backfill missing invoice numbers",
    projectId: "p-payments-api",
    status: "busy",
    minutesAgo: 120,
    model: GPT,
  }),
  IDEAL_NOTES,
  ROTATE_STAGING,
  buildSpecimenSession({
    id: "s-cart-totals",
    title: "Refactor cart totals",
    projectId: "p-webshop",
    status: "busy",
    minutesAgo: 8,
    model: CLAUDE_SONNET,
  }),
];

/** The worktree of scene 7's group of three. */
const THREE_DS_WORKSPACE = buildWorktree("ws-3ds", WEBSHOP_REPO, "fix/3ds-eu-cards", []);

/**
 * Scene 7's group of three: the lead waits on an approval, "research" is
 * idle and "review" works.
 */
const THREE_DS_GROUP: ReadonlyArray<Session> = [
  buildSpecimenSession({
    id: "s-3ds-lead",
    title: "Fix 3-D Secure checkout for EU cards",
    projectId: "p-webshop",
    workspaceId: THREE_DS_WORKSPACE.id,
    status: "busy",
    minutesAgo: 75,
    model: CLAUDE_OPUS,
    openRequests: [
      {
        requestId: "rq-3ds-lead",
        itemId: "it-3ds-lead",
        kind: "command_approval",
        decisions: ["allow", "deny"],
        detail: { command: "git push -u origin fix/3ds-eu-cards" },
      },
    ],
  }),
  buildSpecimenSession({
    id: "s-3ds-research",
    title: "Research how Stripe reports processing states",
    role: "research",
    projectId: "p-webshop",
    workspaceId: THREE_DS_WORKSPACE.id,
    status: "idle",
    minutesAgo: 20,
    model: CLAUDE_SONNET,
  }),
  buildSpecimenSession({
    id: "s-3ds-review",
    title: "Try to break the 3-D Secure fix",
    role: "review",
    projectId: "p-webshop",
    workspaceId: THREE_DS_WORKSPACE.id,
    status: "busy",
    minutesAgo: 12,
    model: GPT,
  }),
];

/**
 * Scene 7's rows of a single thread: one in webshop that is idle, and one
 * in ops.
 */
const SCENE_7_SINGLES: ReadonlyArray<Session> = [
  buildSpecimenSession({
    id: "s-screen-readers",
    title: "Audit checkout for screen readers",
    projectId: "p-webshop",
    status: "idle",
    minutesAgo: 45,
    model: CLAUDE_SONNET,
  }),
  buildSpecimenSession({
    id: "s-grafana-folder",
    title: "Move the dashboards into the new folder",
    projectId: "p-ops",
    status: "busy",
    minutesAgo: 30,
    model: CLAUDE_SONNET,
  }),
];

/** The six idle partners of the group of ten: role, title, minutes since last active, and model. */
const IDLE_PARTNERS: ReadonlyArray<readonly [string, string, number, SpecimenModel]> = [
  ["inventory", "Count the endpoints left to migrate", 50, CLAUDE_SONNET],
  ["benchmark", "Benchmark the Result wrapper", 45, GPT],
  ["mobile check", "Check the mobile clients for the old error shape", 40, GPT],
  ["refunds review", "Review the refunds endpoints", 35, CLAUDE_OPUS],
  ["lint", "Add a lint rule against throwing in handlers", 30, CLAUDE_SONNET],
  ["changelog", "Draft the changelog entry", 25, CLAUDE_SONNET],
];

/**
 * Scene 8's group of ten, which scenes 9 and 11 draw too: the lead and
 * "tests" and "API docs" work, "review" waits, and six partners are idle.
 * It shows three dots and "+7", and unfolded, four lines and "6 quiet".
 */
const RESULT_CREW: ReadonlyArray<Session> = [
  ...RESULT_PAIR,
  buildSpecimenSession({
    id: "s-result-tests",
    title: "Write the tests for the Result endpoints",
    role: "tests",
    projectId: "p-payments-api",
    workspaceId: RESULT_WORKSPACE.id,
    status: "busy",
    minutesAgo: 60,
    model: GPT,
  }),
  buildSpecimenSession({
    id: "s-result-docs",
    title: "Update the API docs for the new error shape",
    role: "API docs",
    projectId: "p-payments-api",
    workspaceId: RESULT_WORKSPACE.id,
    status: "busy",
    minutesAgo: 55,
    model: CLAUDE_SONNET,
  }),
  ...IDLE_PARTNERS.map(([role, title, minutesAgo, model]) =>
    buildSpecimenSession({
      id: `s-result-${role.replace(" ", "-")}`,
      title,
      role,
      projectId: "p-payments-api",
      workspaceId: RESULT_WORKSPACE.id,
      status: "idle",
      minutesAgo,
      model,
    }),
  ),
];

/** Scene 8's rows of a single thread, beside the group of ten. */
const SCENE_8_SINGLES: ReadonlyArray<Session> = [
  buildSpecimenSession({
    id: "s-payout-sept",
    title: "Payout report for September",
    projectId: "p-payments-api",
    status: "busy",
    minutesAgo: 10,
    model: GPT,
    openRequests: [
      {
        requestId: "rq-payout-sept",
        itemId: "it-payout-sept",
        kind: "command_approval",
        decisions: ["allow", "deny"],
        detail: { command: "pnpm run payouts:dry-run --month 2026-09" },
      },
    ],
  }),
  IDEAL_NOTES,
  ROTATE_STAGING,
];

/**
 * Scene 10's group of three Threads and an Agent session that ended, all Done
 * together, 20 minutes ago.
 */
const THREE_DS_DONE_GROUP: ReadonlyArray<Session> = [
  ...THREE_DS_GROUP.map((session) =>
    markDoneBefore({ ...session, openRequests: [], status: "idle" }, 20),
  ),
  buildSpecimenSession({
    id: "s-3ds-lint-agent",
    title: "Lint the checkout changes",
    agentId: "a-linter",
    projectId: "p-webshop",
    workspaceId: THREE_DS_WORKSPACE.id,
    status: "exited",
    exitedAt: buildTimeBefore(22),
    minutesAgo: 22,
    model: CLAUDE_SONNET,
  }),
];

/**
 * Scene 10's threads: a Thread that works and one that is idle, a lone
 * Thread marked Done earlier, and the group of three marked Done 20 minutes
 * ago.
 */
const SCENE_10_THREADS: ReadonlyArray<Session> = [
  ...THREE_DS_DONE_GROUP,
  markDoneBefore(
    buildSpecimenSession({
      id: THREAD_IDS.stripeBump,
      title: "Bump the Stripe SDK to v14",
      projectId: "p-webshop",
      workspaceId: "ws-webshop-main",
      status: "idle",
      minutesAgo: 400,
      model: CLAUDE_SONNET,
    }),
    180,
  ),
  buildSpecimenSession({
    id: "s-cart-totals",
    title: "Refactor cart totals",
    projectId: "p-webshop",
    status: "busy",
    minutesAgo: 8,
    model: CLAUDE_SONNET,
  }),
  buildSpecimenSession({
    id: "s-screen-readers",
    title: "Audit checkout for screen readers",
    projectId: "p-webshop",
    status: "idle",
    minutesAgo: 45,
    model: CLAUDE_SONNET,
  }),
];

/**
 * Returns every list the sidebar reads, holding `threads` and every scene's
 * projects, workspaces and runners, and the group worktrees of scenes 6 to 11.
 */
const buildSceneRecords = (threads: ReadonlyArray<Session>): SidebarRecords => ({
  threads,
  assistants: [],
  projects: PROJECTS,
  workspaces: [...WORKSPACES, RESULT_WORKSPACE, THREE_DS_WORKSPACE],
  resources: [WEBSHOP_REPO, ONBOARDING_REPO],
  runners: [STUDIO_MAC, BUILD_BOX],
  instances: SPECIMEN_INSTANCES,
  user: { username: "Rogier" },
});

/** One scene of the sidebar states specimen. */
export interface SidebarScene {
  readonly records: SidebarRecords;
  /** The app's address: `/threads/<id>` opens that thread, `/` a Draft Thread in no project. */
  readonly path: string;
  /** The text of the "more" row the page presses once the sidebar is drawn, or `null` to press none. */
  readonly pressMore: string | null;
  /** Whether the page opens the Done shelf once the sidebar is drawn, as a press on its heading would. */
  readonly openDoneShelf: boolean;
  /** The session ids of the threads whose composer holds an unsent message. */
  readonly unsentThreadIds: readonly string[];
  /** The face the page switches the sidebar to once it is drawn, as a press on the switch would. */
  readonly face: SidebarFace;
  /** The title of the group whose dots the page presses once the sidebar is drawn, to unfold it, or `null` to press none. */
  readonly unfoldGroup: string | null;
  /** The title of the group whose card the page shows once the sidebar is drawn, as the pointer resting on its row would, or `null` to show none. */
  readonly showCardOf: string | null;
}

/** The title of scene 8's group of ten. */
const RESULT_GROUP_TITLE = "Migrate the unmigrated payout endpoints to the Result error shape";

/** The fields a scene leaves at their default unless it sets them. */
const SCENE_DEFAULTS = {
  pressMore: null,
  openDoneShelf: false,
  unsentThreadIds: [],
  face: "threads",
  unfoldGroup: null,
  showCardOf: null,
} as const satisfies Omit<SidebarScene, "records" | "path">;

/** The scenes, in order: `?scene=1` is the first. */
export const SIDEBAR_SCENES: ReadonlyArray<SidebarScene> = [
  {
    ...SCENE_DEFAULTS,
    records: buildSceneRecords(SCENE_1_THREADS),
    path: `/threads/${THREAD_IDS.applePay}`,
    unsentThreadIds: [THREAD_IDS.altText],
  },
  {
    ...SCENE_DEFAULTS,
    records: buildSceneRecords(SCENE_2_THREADS),
    path: "/threads/s-playwright-flake",
  },
  {
    ...SCENE_DEFAULTS,
    records: buildSceneRecords(PAYMENTS_THREADS),
    // One of the five threads the project shows, so the "more" row still
    // counts two hidden threads.
    path: "/threads/s-refund-webhooks",
    pressMore: "2 more",
  },
  {
    ...SCENE_DEFAULTS,
    records: { ...buildSceneRecords(SCENE_2_THREADS), connections: [FAILED_CONNECTION] },
    path: "/",
    face: "orchestration",
  },
  {
    ...SCENE_DEFAULTS,
    records: buildSceneRecords(SCENE_5_THREADS),
    path: `/threads/${THREAD_IDS.flakyTest}`,
    openDoneShelf: true,
  },
  {
    ...SCENE_DEFAULTS,
    records: buildSceneRecords([...RESULT_PAIR, ...SCENE_6_SINGLES]),
    path: "/threads/s-ideal-notes",
  },
  {
    ...SCENE_DEFAULTS,
    records: buildSceneRecords([...THREE_DS_GROUP, ...SCENE_7_SINGLES]),
    path: "/threads/s-3ds-lead",
    unfoldGroup: "Fix 3-D Secure checkout for EU cards",
  },
  {
    ...SCENE_DEFAULTS,
    records: buildSceneRecords([...RESULT_CREW, ...SCENE_8_SINGLES]),
    path: "/threads/s-ideal-notes",
  },
  {
    ...SCENE_DEFAULTS,
    records: buildSceneRecords([...RESULT_CREW, ...SCENE_8_SINGLES]),
    path: "/threads/s-ideal-notes",
    unfoldGroup: RESULT_GROUP_TITLE,
  },
  {
    ...SCENE_DEFAULTS,
    records: buildSceneRecords(SCENE_10_THREADS),
    path: "/threads/s-cart-totals",
    openDoneShelf: true,
  },
  {
    ...SCENE_DEFAULTS,
    records: buildSceneRecords([...RESULT_CREW, ...SCENE_8_SINGLES]),
    path: "/threads/s-ideal-notes",
    showCardOf: RESULT_GROUP_TITLE,
  },
];
