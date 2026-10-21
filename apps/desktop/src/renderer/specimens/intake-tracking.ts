/**
 * The Tracking read behind the Tracking scenes of intake-fixture.ts: what
 * `task.queryTracking` returns, which the real Intake screen draws.
 *
 * The rows are the Tracking drawing's (docs/design/tracking/tracking-data.js,
 * at 09:41). The two Needs you rows are not in `TRACKING_RECORDS`: a Task is
 * Needs you only with something that waits on it, so they come with what
 * waits, in `NEEDS_YOU_RECORDS`. The drawing's lines that need more than a run
 * summary hold differ:
 *
 * - A Working row's line is "working", not the agent's latest message, and a
 *   run that waits on a signal trigger names the trigger ("waiting for
 *   checks"), not the pull request.
 * - A Stopped row's line is "stopped", because a summary does not say who
 *   cancelled the run.
 *
 * The book casts some workflows' faces by hand and hashes the others' from the
 * name, and the app hashes a workflow's id. So a workflow's id is its name
 * here, so the hashed faces are the drawing's, except for Fix bug, whose id is
 * a seed that hashes to the look the book casts for it. Investigate's cast
 * look, with a tache and a homburg, is Hercule's, which no seed can hash to,
 * so its face differs.
 */
import type { Session, Task, TrackingRun, TrackingTask } from "@hercule/contract";
import { SPECIMEN_NOW, SPECIMEN_RECORDS } from "./sidebar-fixture";

/** The ids that give a workflow the face the book casts for it, where its name would hash to another. */
const WORKFLOW_SEEDS: Readonly<Record<string, string>> = { "Fix bug": "Fix bug 160" };

/** Returns the moment `minutes` before the specimen's clock, as an ISO time. */
const minutesAgo = (minutes: number): string =>
  new Date(SPECIMEN_NOW - minutes * 60_000).toISOString();

/** Builds the run `id` of the workflow `workflowName`, created `createdMinutes` before the specimen's clock. */
const buildRun = (
  id: string,
  workflowName: string,
  createdMinutes: number,
  rest: Pick<TrackingRun, "status"> & Partial<TrackingRun>,
): TrackingRun => ({
  id,
  workflowId: WORKFLOW_SEEDS[workflowName] ?? workflowName,
  workflowName,
  createdAt: minutesAgo(createdMinutes),
  awaitedSignalIds: [],
  ...rest,
});

/** Builds a tracked Task handed off `handedOffMinutes` before the specimen's clock, with its newest run. */
const buildTask = (
  taskId: string,
  title: string,
  handedOffMinutes: number,
  latestRun: TrackingRun,
): TrackingTask => ({
  taskId,
  title,
  handoffs: [
    { signalId: `signal-${taskId}`, runId: latestRun.id, at: minutesAgo(handedOffMinutes) },
  ],
  latestRun,
  ...(latestRun.status === "pending" || latestRun.status === "running"
    ? { latestLiveRun: latestRun }
    : {}),
});

const BACKUP = buildTask(
  "t-backup",
  "Nightly backup job timing out on ops-db",
  21,
  buildRun("run-t-backup", "Investigate", 21, {
    status: "failed",
    startedAt: minutesAgo(21),
    finishedAt: minutesAgo(15),
    failureCause: "permission denied on ops-db",
  }),
);
const RATE_LIMIT = buildTask(
  "t-1296",
  "Rate-limit the public API",
  29,
  buildRun("run-t-1296", "Review PR", 29, {
    status: "completed",
    startedAt: minutesAgo(29),
    finishedAt: minutesAgo(21),
  }),
);
const CHECKOUT = buildTask(
  "t-checkout",
  "Split checkout into steps",
  43,
  buildRun("run-t-checkout", "Implement", 43, {
    status: "running",
    startedAt: minutesAgo(11),
    awaitedSignalIds: ["checks"],
  }),
);
const SKU = buildTask(
  "t-sku",
  "Lowercase SKUs in search",
  8,
  buildRun("run-t-sku", "Fix bug", 6, { status: "running", startedAt: minutesAgo(5) }),
);
const PDF = buildTask(
  "t-pdf",
  "Move invoices to the new PDF renderer",
  80,
  buildRun("run-t-pdf", "Implement", 80, { status: "cancelled", finishedAt: minutesAgo(54) }),
);

/** What `task.queryTracking` returns for a Tracking scene: five rows, one in each state but two Working. */
export const TRACKING_RECORDS: ReadonlyArray<TrackingTask> = [
  BACKUP,
  RATE_LIMIT,
  CHECKOUT,
  SKU,
  PDF,
];

/** The pull request the checks of Refunds for partial captures failed on, as a signal's thread names it. */
export const REFUNDS_PULL_REQUEST_REF = "github:pull:payments-api#1302";

const REFUNDS = buildTask(
  "t-212",
  "Refunds for partial captures",
  70,
  buildRun("run-t-212", "Implement", 70, {
    status: "completed",
    startedAt: minutesAgo(70),
    finishedAt: minutesAgo(49),
  }),
);
const SDK = buildTask(
  "t-sdk",
  "Upgrade the Stripe SDK to v14",
  19,
  buildRun("run-t-sdk", "Implement", 19, { status: "running", startedAt: minutesAgo(19) }),
);

/**
 * The Task Refunds for partial captures as `task.query` returns it, with the
 * pull request's ref in its provenance. A signal whose thread is that pull
 * request is about this Task (Your work).
 */
const REFUNDS_TASK: Task = {
  id: REFUNDS.taskId,
  title: REFUNDS.title,
  description: "",
  status: "in-progress",
  priority: "normal",
  labels: [],
  provenance: [
    {
      signalId: REFUNDS.handoffs[0]!.signalId,
      runId: REFUNDS.latestRun.id,
      ref: REFUNDS_PULL_REQUEST_REF,
      at: minutesAgo(70),
      actor: "user",
    },
  ],
  createdAt: minutesAgo(70),
  updatedAt: minutesAgo(49),
  statusChangedAt: minutesAgo(70),
};

/** The Sentry issue behind the alert on checkout, as a signal's thread names it. */
export const FIX_CHECKOUT_REF = "sentry:issue:WEBSHOP-3DS";

const FIX_CHECKOUT = buildTask(
  "t-3ds",
  "Fix 3-D Secure checkout for EU cards",
  40,
  buildRun("run-t-3ds", "Fix bug", 40, { status: "running", startedAt: minutesAgo(39) }),
);

/** Builds an open Task as `task.query` returns it, with the thread ref `ref` in its provenance. */
const buildWorkTask = (
  id: string,
  title: string,
  status: Task["status"],
  ref: string,
  signalId: string,
  runId: string | undefined,
): Task => ({
  id,
  title,
  description: "",
  status,
  priority: "normal",
  labels: [],
  provenance: [
    { signalId, ...(runId === undefined ? {} : { runId }), ref, at: minutesAgo(40), actor: "user" },
  ],
  createdAt: minutesAgo(40),
  updatedAt: minutesAgo(30),
  statusChangedAt: minutesAgo(40),
});

/**
 * What a scene with Your work on a Now signal holds: the Task that fixes the
 * alert on checkout, which an agent works on, besides the Tracking rows of
 * the drawing.
 */
export const YOUR_WORK_RECORDS = {
  tracking: [FIX_CHECKOUT, ...TRACKING_RECORDS],
  yourWorkTasks: [
    buildWorkTask(
      "t-3ds",
      FIX_CHECKOUT.title,
      "in-progress",
      FIX_CHECKOUT_REF,
      "signal-t-3ds",
      "run-t-3ds",
    ),
  ],
};

/** An open Task on the agent's pull request that nobody handed to an agent, so no row of Tracking follows it. */
export const UNTRACKED_WORK_TASK: Task = buildWorkTask(
  "t-docs",
  "Document the refund flow",
  "open",
  REFUNDS_PULL_REQUEST_REF,
  "signal-t-docs",
  undefined,
);

/** The session of the Upgrade the Stripe SDK run that asks to run `git push`, 3 minutes ago. */
const SDK_SESSION: Session = {
  ...SPECIMEN_RECORDS.threads[0]!,
  id: "01a0ec64-7a00-7000-8000-0000000000e1",
  title: "Implement · implement",
  status: "busy",
  runId: SDK.latestRun.id,
  stepId: "implement",
  openRequests: [
    {
      requestId: "r-sdk",
      itemId: "tool-sdk",
      decisions: ["allow", "deny"],
      kind: "command_approval",
      detail: { command: "git push -u origin chore/stripe-sdk-14" },
    },
  ],
  lastActivityAt: minutesAgo(3),
};

/**
 * What a Tracking scene with the two Needs you rows holds, beside the
 * signals on To do (which must include the checks that failed on
 * `REFUNDS_PULL_REQUEST_REF`):
 *
 * - `tracking`: the drawing's seven rows;
 * - `agentSessions`: the session whose Request makes Upgrade the Stripe SDK Needs you;
 * - `yourWorkTasks`: the Task the failed checks are about, which makes Refunds for partial captures Needs you.
 */
export const NEEDS_YOU_RECORDS = {
  tracking: [REFUNDS, SDK, ...TRACKING_RECORDS],
  agentSessions: [SDK_SESSION],
  yourWorkTasks: [REFUNDS_TASK],
};
