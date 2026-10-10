/**
 * The records of the sidebar states specimen (sidebar-states.tsx): four
 * scenes that draw the sidebar states the Bureau book never draws, for a
 * check by eye. `node scripts/capture-sidebar-states.ts` captures each scene
 * in both themes.
 *
 * - Scene 1 has an open thread and three projects:
 *   - webshop, whose threads work in a worktree, in the main workspace and in
 *     no workspace, so the rows' third lines show each kind. The open thread
 *     is in the worktree, and the composer of "Tidy product image alt text"
 *     holds an unsent message, so its row is tinted;
 *   - ops, whose three threads each end their row differently: "queued",
 *     "offline", and the age of an ended thread. An asleep thread, or one
 *     the crash-loop guard holds, ends its row with its age too, so the
 *     scene leaves them out to fit the capture's window;
 *   - a project with a very long name, whose main workspace's name and
 *     whose thread's title are too long for the sidebar.
 * - Scene 2 has no open thread. Four threads wait on the user, so Waiting on
 *   you shows three and a "more" row; payments-api has seven threads, so it
 *   shows five and a "more" row; and one thread belongs to no project.
 * - Scene 3 is scene 2 without the threads in no project, and with
 *   payments-api's "more" row pressed, so the project shows every thread.
 *   With three lines per row, scene 2 expanded would be taller than the
 *   capture's window.
 * - Scene 4 is scene 2 on the Hercule face, with a GitHub Connection whose
 *   last check failed, so the Connections row ends in the red dot.
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
  CLAUDE_SONNET,
  GPT,
  SPECIMEN_INSTANCES,
  SPECIMEN_NOW,
  STUDIO_MAC,
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
  kycRetries: "s-kyc-retries",
} as const;

/**
 * The workspaces: a worktree of webshop, then the main workspaces of webshop
 * and of the long-named project, all on studio-mac.
 */
const WORKSPACES = [
  buildWorkspace({
    id: "ws-thread-3f1",
    runnerId: STUDIO_MAC.id,
    kind: "ephemeral",
    checkouts: [{ ...buildCheckout(WEBSHOP_REPO.id, "hercule/thread-3f1"), form: "worktree" }],
    sessionIds: [THREAD_IDS.flakyTest, THREAD_IDS.applePay],
  }),
  buildWorkspace({
    id: "ws-webshop-main",
    runnerId: STUDIO_MAC.id,
    kind: "primary",
    checkouts: [buildCheckout(WEBSHOP_REPO.id, "main", ["main", "hercule/thread-3f1"])],
    sessionIds: [THREAD_IDS.stripeBump, THREAD_IDS.altText],
  }),
  buildWorkspace({
    id: "ws-onboarding-main",
    runnerId: STUDIO_MAC.id,
    kind: "primary",
    checkouts: [buildCheckout(ONBOARDING_REPO.id, "main")],
    sessionIds: [THREAD_IDS.proxy502, THREAD_IDS.kycRetries],
  }),
];

/** Returns the moment `minutes` minutes before `SPECIMEN_NOW`, as the API spells a time. */
const buildTimeBefore = (minutes: number): string =>
  new Date(SPECIMEN_NOW - minutes * 60_000).toISOString();

/**
 * Scene 1's threads. Each was created when it was last active.
 *
 * webshop has five threads, as many as a project shows, so there is no
 * "more" row. With three rows per thread, a sixth would make the list taller
 * than the capture's window.
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
    workspaceId: "ws-thread-3f1",
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
    workspaceId: "ws-webshop-main",
    status: "idle",
    minutesAgo: 40,
    model: CLAUDE_SONNET,
  }),
  buildSpecimenSession({
    id: "s-pricing-copy",
    title: "Draft the Q4 pricing page copy",
    projectId: "p-webshop",
    status: "idle",
    minutesAgo: 95,
    model: GPT,
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
  buildSpecimenSession({
    id: THREAD_IDS.kycRetries,
    title: "Retry failed KYC document uploads",
    projectId: "p-onboarding",
    workspaceId: "ws-onboarding-main",
    status: "busy",
    minutesAgo: 30,
    model: CLAUDE_SONNET,
  }),
];

/**
 * payments-api's seven threads, in no workspace: three waiting, two working
 * and two that are neither. Capped, it shows the waiting and the working
 * ones, and "2 more threads".
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

/** Returns every list the sidebar reads, holding `threads` and every scene's projects, workspaces and runners. */
const buildSceneRecords = (threads: ReadonlyArray<Session>): SidebarRecords => ({
  threads,
  assistants: [],
  projects: PROJECTS,
  workspaces: WORKSPACES,
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
  /** The session ids of the threads whose composer holds an unsent message. */
  readonly unsentThreadIds: readonly string[];
  /** The face the page switches the sidebar to once it is drawn, as a press on the switch would. */
  readonly face: SidebarFace;
}

/** The scenes, in order: `?scene=1` is the first. */
export const SIDEBAR_SCENES: ReadonlyArray<SidebarScene> = [
  {
    records: buildSceneRecords(SCENE_1_THREADS),
    path: `/threads/${THREAD_IDS.applePay}`,
    pressMore: null,
    unsentThreadIds: [THREAD_IDS.altText],
    face: "threads",
  },
  {
    records: buildSceneRecords(SCENE_2_THREADS),
    path: "/",
    pressMore: null,
    unsentThreadIds: [],
    face: "threads",
  },
  {
    records: buildSceneRecords(PAYMENTS_THREADS),
    path: "/",
    pressMore: "2 more threads",
    unsentThreadIds: [],
    face: "threads",
  },
  {
    records: { ...buildSceneRecords(SCENE_2_THREADS), connections: [FAILED_CONNECTION] },
    path: "/",
    pressMore: null,
    unsentThreadIds: [],
    face: "orchestration",
  },
];
