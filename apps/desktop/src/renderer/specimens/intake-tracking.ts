/**
 * The Tasks and runs behind the Tracking scenes `tracking-folded`,
 * `tracking-opened` and `tracking-empty` of intake-fixture.ts, which the real
 * Intake screen draws from the shell's reads.
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
import type { Run, RunSummary, Task } from "@hercule/contract";
import { SPECIMEN_NOW } from "./sidebar-fixture";

/** The ids that give a workflow the face the book casts for it, where its name would hash to another. */
const WORKFLOW_SEEDS: Readonly<Record<string, string>> = { "Fix bug": "Fix bug 160" };

/** Returns the moment `minutes` before the specimen's clock, as an ISO time. */
const minutesAgo = (minutes: number): string =>
  new Date(SPECIMEN_NOW - minutes * 60_000).toISOString();

/** Builds a Task handed off `handedOffMinutes` before the specimen's clock. */
const buildTask = (id: string, title: string, handedOffMinutes: number): Task => ({
  id,
  title,
  description: "",
  status: "in-progress",
  priority: "normal",
  labels: [],
  provenance: [
    {
      signalId: `signal-${id}`,
      runId: `run-${id}`,
      at: minutesAgo(handedOffMinutes),
      actor: "user",
    },
  ],
  createdAt: minutesAgo(handedOffMinutes),
  updatedAt: minutesAgo(handedOffMinutes),
  statusChangedAt: minutesAgo(handedOffMinutes),
});

/** The fields every run summary of a scene shares with the Task it works on. */
const summaryOf = (taskId: string, workflowName: string, startedMinutes: number) => ({
  id: `run-${taskId}`,
  taskId,
  workflowId: WORKFLOW_SEEDS[workflowName] ?? workflowName,
  workflowName,
  origin: { kind: "manual", actor: "user" } as const,
  createdAt: minutesAgo(startedMinutes),
});

const BACKUP = buildTask("t-backup", "Nightly backup job timing out on ops-db", 21);
const RATE_LIMIT = buildTask("t-1296", "Rate-limit the public API", 29);
const CHECKOUT = buildTask("t-checkout", "Split checkout into steps", 43);
const SKU = buildTask("t-sku", "Lowercase SKUs in search", 8);
const PDF = buildTask("t-pdf", "Move invoices to the new PDF renderer", 80);

const RUNS: ReadonlyArray<RunSummary> = [
  {
    ...summaryOf(BACKUP.id, "Investigate", 21),
    status: "failed",
    failureReason: "step-failed",
    failedStepId: "look",
    startedAt: minutesAgo(21),
    finishedAt: minutesAgo(15),
  },
  {
    ...summaryOf(RATE_LIMIT.id, "Review PR", 29),
    status: "completed",
    startedAt: minutesAgo(29),
    finishedAt: minutesAgo(21),
  },
  {
    ...summaryOf(CHECKOUT.id, "Implement", 43),
    status: "running",
    startedAt: minutesAgo(11),
    activeStepIds: [],
    awaitedSignalIds: ["checks"],
  },
  {
    ...summaryOf(SKU.id, "Fix bug", 8),
    status: "running",
    startedAt: minutesAgo(6),
    activeStepIds: ["fix"],
    awaitedSignalIds: [],
  },
  {
    ...summaryOf(PDF.id, "Implement", 80),
    status: "cancelled",
    finishedAt: minutesAgo(54),
  },
];

/** The failed run as `run.read` returns it, whose step record gives the row's reason. */
const BACKUP_RUN: Run = {
  id: `run-${BACKUP.id}`,
  taskId: BACKUP.id,
  workflowId: "Investigate",
  plan: {
    name: "Investigate",
    triggers: [{ id: "manual", kind: "start", on: { kind: "manual" } }],
    steps: [{ id: "look", kind: "action", action: "task.create" }],
    edges: [],
  },
  inputs: {},
  origin: { kind: "manual", actor: "user" },
  subscriptions: [],
  edgeTraversals: [],
  createdAt: minutesAgo(21),
  status: "failed",
  failureReason: "step-failed",
  failedStepId: "look",
  startedAt: minutesAgo(21),
  finishedAt: minutesAgo(15),
  steps: [
    {
      stepId: "look",
      iteration: 1,
      status: "failed",
      startedAt: minutesAgo(21),
      finishedAt: minutesAgo(15),
      error: { code: "denied", message: "permission denied on ops-db" },
    },
  ],
};

/** The records a Tracking scene seeds the shell with: five rows, one in each state but two Working. */
export const TRACKING_RECORDS = {
  tasks: [BACKUP, RATE_LIMIT, CHECKOUT, SKU, PDF],
  runs: RUNS,
  failedRuns: [BACKUP_RUN],
} as const;
