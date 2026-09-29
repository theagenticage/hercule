/**
 * The records of the sidebar states specimen (sidebar-states.tsx): three
 * scenes that draw the sidebar states the Bureau book never draws, for a
 * check by eye. `node scripts/capture-sidebar-states.ts` captures each scene
 * in both themes.
 *
 * - Scene 1 has an open thread and three projects:
 *   - webshop, whose threads are split into workspace groups: a worktree, the
 *     main workspace and "no workspace", two threads each. The open thread
 *     sits in the worktree's group;
 *   - ops, whose five threads each end their row differently: "queued",
 *     "offline", and the ages of a thread the crash-loop guard holds, an
 *     asleep thread and an ended one;
 *   - a project with a very long name, whose main workspace's label and
 *     whose thread's title are too long for the sidebar.
 * - Scene 2 has no open thread. Five threads wait on the user, so Waiting on
 *   you shows three and a "more" row; payments-api has eight threads, so it
 *   shows five and a "more" row; and four threads belong to no project.
 * - Scene 3 is scene 2 with payments-api's "more" row pressed, so the
 *   project shows every thread.
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
import type { SidebarRecords } from "./sidebar-page";

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
 * The workspaces, in catalog order: a worktree of webshop, which the sidebar
 * lists first in its project, then the main workspaces of webshop and of the
 * long-named project, both on studio-mac.
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
 * Scene 1's threads, newest first in each group.
 *
 * webshop's six threads are one more than a project shows. Its two working
 * threads and three newest idle ones are picked; the sixth, Apple Pay, is
 * shown only because it is the open thread. So every group shows both its
 * threads and there is no "more" row.
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
  buildSpecimenSession({
    id: "s-support-summary",
    title: "Summarize last week's support tickets",
    projectId: "p-webshop",
    status: "idle",
    minutesAgo: 120,
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
    id: "s-postgres-upgrade",
    title: "Upgrade Postgres to 17",
    projectId: "p-ops",
    // It exited before its first turn too many times: the crash-loop guard
    // holds it until the user's next message.
    status: "exited",
    resumable: true,
    resumeHeld: true,
    exitedAt: buildTimeBefore(50),
    minutesAgo: 50,
    model: CLAUDE_SONNET,
  }),
  buildSpecimenSession({
    id: "s-grafana-migration",
    title: "Migrate ops dashboards to Grafana 11",
    projectId: "p-ops",
    // Asleep: the next message resumes it.
    status: "exited",
    resumable: true,
    exitedAt: buildTimeBefore(300),
    minutesAgo: 300,
    model: GPT,
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
 * Scene 2's threads, all in no workspace.
 *
 * - payments-api has eight: three waiting, two working and three that are
 *   neither. It shows the waiting and the working ones, and "3 more threads".
 * - Four belong to no project, two of them waiting.
 * - Waiting on you counts all five waiting threads, shows the three newest,
 *   and "2 more waiting on you".
 */
const SCENE_2_THREADS: ReadonlyArray<Session> = [
  buildSpecimenSession({
    id: "s-payout-report",
    title: "Payout report for September",
    projectId: "p-payments-api",
    status: "busy",
    minutesAgo: 1,
    model: GPT,
    openRequest: {
      requestId: "rq-payout-report",
      itemId: "it-payout-report",
      kind: "command_approval",
      decisions: ["allow", "deny"],
      detail: { command: "pnpm run payouts:dry-run --month 2026-09" },
    },
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
    openRequest: {
      requestId: "rq-adyen-reconcile",
      itemId: "it-adyen-reconcile",
      kind: "file_change_approval",
      decisions: ["allow", "deny"],
      detail: { paths: ["src/reconcile/adyen.ts"] },
    },
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
    openRequest: {
      requestId: "rq-ideal-research",
      itemId: "it-ideal-research",
      kind: "question",
      decisions: ["allow", "cancel"],
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
    id: "s-chargeback-docs",
    title: "Document the chargeback flow",
    projectId: "p-payments-api",
    status: "idle",
    minutesAgo: 70,
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
  // The threads in no project.
  buildSpecimenSession({
    id: "s-playwright-flake",
    title: "Explain the flaky Playwright run",
    status: "busy",
    minutesAgo: 3,
    model: CLAUDE_SONNET,
    openRequest: {
      requestId: "rq-playwright-flake",
      itemId: "it-playwright-flake",
      kind: "tool_approval",
      decisions: ["allow", "deny"],
      detail: { toolName: "WebFetch" },
    },
  }),
  buildSpecimenSession({
    id: "s-incident-notes",
    title: "Summarize the incident notes",
    status: "busy",
    minutesAgo: 8,
    model: CLAUDE_SONNET,
    openRequest: {
      requestId: "rq-incident-notes",
      itemId: "it-incident-notes",
      kind: "file_read_approval",
      decisions: ["allow", "deny"],
      detail: { paths: ["notes/2026-09-27-incident.md", "notes/2026-09-28-incident.md"] },
    },
  }),
  buildSpecimenSession({
    id: "s-auditor-reply",
    title: "Draft a reply to the auditor",
    status: "busy",
    minutesAgo: 14,
    model: GPT,
  }),
  buildSpecimenSession({
    id: "s-hosting-prices",
    title: "Compare Hetzner and OVH pricing",
    status: "idle",
    minutesAgo: 120,
    model: GPT,
  }),
];

/** Returns every list the sidebar reads, holding `threads` and every scene's projects, workspaces and runners. */
const buildSceneRecords = (threads: ReadonlyArray<Session>): SidebarRecords => ({
  threads,
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
  /** The app's address: `/threads/<id>` opens that thread, `/` opens none. */
  readonly path: string;
  /** The text of the "more" row the page presses once the sidebar is drawn, or `null` to press none. */
  readonly pressMore: string | null;
}

/** The scenes, in order: `?scene=1` is the first. */
export const SIDEBAR_SCENES: ReadonlyArray<SidebarScene> = [
  {
    records: buildSceneRecords(SCENE_1_THREADS),
    path: `/threads/${THREAD_IDS.applePay}`,
    pressMore: null,
  },
  { records: buildSceneRecords(SCENE_2_THREADS), path: "/", pressMore: null },
  { records: buildSceneRecords(SCENE_2_THREADS), path: "/", pressMore: "3 more threads" },
];
