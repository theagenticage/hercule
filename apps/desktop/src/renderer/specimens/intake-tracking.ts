/**
 * The Tracking read behind the Tracking scenes of intake-fixture.ts: what
 * `task.queryTracking` returns, which the real Intake screen draws.
 *
 * The rows are the Tracking drawing's (docs/design/tracking/tracking-data.js,
 * at 09:41), without the Needs you rows, which come with a later slice. The
 * drawing's lines that need more than a run summary hold differ:
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
import type { TrackingRun, TrackingTask } from "@hercule/contract";
import { SPECIMEN_NOW } from "./sidebar-fixture";

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
  buildRun("run-t-sku", "Fix bug", 8, { status: "running", startedAt: minutesAgo(6) }),
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
