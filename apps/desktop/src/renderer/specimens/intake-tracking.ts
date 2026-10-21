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
import {
  HAND_TO_ACTION_PREFIX,
  type Session,
  type Signal,
  type TrackingDetail,
  type TrackingOutput,
  type TrackingRun,
  type TrackingTask,
  type YourWorkTask,
} from "@hercule/contract";
import { buildSignal, minutesAgo } from "./intake-signal-builder";
import { SPECIMEN_RECORDS } from "./sidebar-fixture";
import type { SidebarRecords } from "./shell-page";

/** The ids that give a workflow the face the book casts for it, where its name would hash to another. */
const WORKFLOW_SEEDS: Readonly<Record<string, string>> = { "Fix bug": "Fix bug 160" };

/**
 * The id of each tracked Task, by the name the drawing gives it. They are
 * UUIDs because the Intake route keeps the selected Task in its `task`
 * param and drops a value that is not an id.
 */
export const TASK_IDS = {
  backup: "01a0ec64-7a00-7000-9000-000000000001",
  rateLimit: "01a0ec64-7a00-7000-9000-000000000002",
  checkout: "01a0ec64-7a00-7000-9000-000000000003",
  sku: "01a0ec64-7a00-7000-9000-000000000004",
  pdf: "01a0ec64-7a00-7000-9000-000000000005",
  refunds: "01a0ec64-7a00-7000-9000-000000000006",
  sdk: "01a0ec64-7a00-7000-9000-000000000007",
  fixCheckout: "01a0ec64-7a00-7000-9000-000000000008",
} as const;

/**
 * Returns the id of the signal handed to the Task `taskId`, the one the
 * Tracking pane shows under "You asked". It is the Task's id with another
 * variant digit, so the two never clash and each names the other.
 */
const buildHandedSignalId = (taskId: string): string => taskId.replace("-9000-", "-a000-");

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
    {
      signalId: buildHandedSignalId(taskId),
      runId: latestRun.id,
      at: minutesAgo(handedOffMinutes),
    },
  ],
  latestRun,
  ...(latestRun.status === "pending" || latestRun.status === "running"
    ? { latestLiveRun: latestRun }
    : {}),
  liveRunIds:
    latestRun.status === "pending" || latestRun.status === "running" ? [latestRun.id] : [],
});

const BACKUP = buildTask(
  TASK_IDS.backup,
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
  TASK_IDS.rateLimit,
  "Rate-limit the public API",
  29,
  buildRun("run-t-1296", "Review PR", 29, {
    status: "completed",
    startedAt: minutesAgo(29),
    finishedAt: minutesAgo(21),
  }),
);
const CHECKOUT = buildTask(
  TASK_IDS.checkout,
  "Split checkout into steps",
  43,
  buildRun("run-t-checkout", "Implement", 43, {
    status: "running",
    startedAt: minutesAgo(11),
    awaitedSignalIds: ["checks"],
  }),
);
const SKU = buildTask(
  TASK_IDS.sku,
  "Lowercase SKUs in search",
  6,
  buildRun("run-t-sku", "Fix bug", 6, { status: "running", startedAt: minutesAgo(6) }),
);
const PDF = buildTask(
  TASK_IDS.pdf,
  "Move invoices to the new PDF renderer",
  61,
  buildRun("run-t-pdf", "Implement", 61, {
    status: "cancelled",
    startedAt: minutesAgo(61),
    finishedAt: minutesAgo(54),
  }),
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
  TASK_IDS.refunds,
  "Refunds for partial captures",
  70,
  buildRun("run-t-212", "Implement", 70, {
    status: "completed",
    startedAt: minutesAgo(70),
    finishedAt: minutesAgo(49),
  }),
);
const SDK = buildTask(
  TASK_IDS.sdk,
  "Upgrade the Stripe SDK to v14",
  19,
  buildRun("run-t-sdk", "Implement", 19, { status: "running", startedAt: minutesAgo(19) }),
);

/** Builds a Task of Your work as `signal.queryYourWork` returns it, about the signal `signalId`. */
const buildWorkTask = (
  id: string,
  title: string,
  status: YourWorkTask["status"],
  signalId: string,
): YourWorkTask => ({ id, title, status, updatedAt: minutesAgo(30), signalIds: [signalId] });

/**
 * The id of the checks that failed on the agent's pull request, which the
 * Tasks Refunds for partial captures and Document the refund flow are Your
 * work for.
 */
export const AGENT_CHECKS_SIGNAL_ID = "01a0ec64-7a00-7000-8000-000000000040";

/** The id of Sentry's alert on checkout, which the Task Fix 3-D Secure checkout is Your work for. */
export const ALERT_SIGNAL_ID = "01a0ec64-7a00-7000-8000-000000000001";

/** The Task Refunds for partial captures, which the failed checks on its pull request are about (Your work). */
const REFUNDS_TASK = buildWorkTask(
  REFUNDS.taskId,
  REFUNDS.title,
  "in-progress",
  AGENT_CHECKS_SIGNAL_ID,
);

/** The Sentry issue behind the alert on checkout, as a signal's thread names it. */
export const FIX_CHECKOUT_REF = "sentry:issue:WEBSHOP-3DS";

const FIX_CHECKOUT = buildTask(
  TASK_IDS.fixCheckout,
  "Fix 3-D Secure checkout for EU cards",
  40,
  buildRun("run-t-3ds", "Fix bug", 40, { status: "running", startedAt: minutesAgo(39) }),
);

/**
 * What a scene with Your work on a Now signal holds: the Task that fixes the
 * alert on checkout, which an agent works on, besides the Tracking rows of
 * the drawing.
 */
export const YOUR_WORK_RECORDS: Partial<SidebarRecords> = {
  tracking: [FIX_CHECKOUT, ...TRACKING_RECORDS],
  yourWorkTasks: [
    buildWorkTask(TASK_IDS.fixCheckout, FIX_CHECKOUT.title, "in-progress", ALERT_SIGNAL_ID),
  ],
};

/** An open Task on the agent's pull request that nobody handed to an agent, so no row of Tracking follows it. */
export const UNTRACKED_WORK_TASK: YourWorkTask = buildWorkTask(
  "t-docs",
  "Document the refund flow",
  "open",
  AGENT_CHECKS_SIGNAL_ID,
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
 * Builds the text a step with no output schema leaves: the message's
 * paragraphs, which the controller sends as the output's markdown.
 */
const buildTextOutput = (
  stepName: string,
  sessionId: string,
  paragraphs: ReadonlyArray<string>,
): TrackingOutput => ({ kind: "text", stepName, sessionId, text: paragraphs.join("\n\n") });

/**
 * Builds what `task.readTracking` returns for `task`, which has one run, with
 * the Task's id, which the read is keyed by. The run's last agent step ran in
 * the session `sessionId`.
 */
const buildDetail = (
  task: TrackingTask,
  sessionId: string,
  rest: Pick<TrackingDetail, "output" | "endingActionStepName"> = {},
): readonly [string, TrackingDetail] => [
  task.taskId,
  {
    firstHandoff: {
      ...task.handoffs[task.handoffs.length - 1]!,
      workflowName: task.latestRun.workflowName,
    },
    runs: [{ ...task.latestRun, sessionId }],
    ...rest,
  },
];

/** Builds the session id of the run of the task numbered `number`, as the pane's "Thread" link names it. */
const buildSessionId = (number: number): string =>
  `01a0ec64-7a00-7000-8000-${String(number + 300).padStart(12, "0")}`;

/**
 * What `task.readTracking` returns, by the Task's id, for each tracked Task
 * the drawing opens a pane for, with the text of the drawing
 * (docs/design/tracking). Where the
 * drawing's wording needs more than the read holds, the read holds less:
 *
 * - The drawing does not name the step a text output comes from, except for
 *   Refunds for partial captures. The names here are plausible ones.
 * - Refunds for partial captures ends on the action "Open a pull request"; the
 *   drawing adds what it did, "Opened draft PR #1302", which no record holds.
 * - A Working run has no output: the pane does not draw one.
 */
export const TRACKING_DETAILS: ReadonlyMap<string, TrackingDetail> = new Map([
  buildDetail(RATE_LIMIT, buildSessionId(2), {
    output: {
      kind: "fields",
      stepName: "Review",
      sessionId: buildSessionId(2),
      fields: [
        { label: "Verdict", value: "approve" },
        {
          label: "Summary",
          value:
            "Approve, with two comments: the refill reads the clock twice, so a burst at the edge of a second can take 601 tokens, and no test covers Retry-After. Read all 6 files and ran the tests: 31 passed.",
        },
        { label: "Comments", value: { items: 2 } },
        { label: "Confidence", value: "high" },
        { label: "Posted to GitHub", value: false },
      ],
    },
  }),
  buildDetail(SDK, SDK_SESSION.id, {
    output: buildTextOutput("Write the change", SDK_SESSION.id, [
      "Replaced the 9 reads of `charges` with `latest_charge` and updated the fixtures. All 212 tests pass. Pushing the branch to open the PR.",
    ]),
  }),
  buildDetail(REFUNDS, buildSessionId(6), {
    output: buildTextOutput("Write the change", buildSessionId(6), [
      "Added `createRefund(orderId, lines)` with a partial amount per line, and a migration for `refund_lines`. Stripe gets one refund per call, with an idempotency key per order and line. Pushed `feat/partial-refunds`. The unit tests pass here; I did not run the Stripe test-mode suite, which needs the team's key.",
    ]),
    endingActionStepName: "Open a pull request",
  }),
  buildDetail(BACKUP, buildSessionId(1), {
    output: buildTextOutput("Check the backup job", buildSessionId(1), [
      "`pg_dump` of `events` (41 GB) took 1h 52m last night, past the job's 90-minute limit. I could not read the slow query log to see what held it up: the role `hercule_ro` may not read `pg_stat_statements`.",
    ]),
  }),
  buildDetail(SKU, buildSessionId(4)),
  buildDetail(PDF, buildSessionId(5), {
    output: buildTextOutput("Write the change", buildSessionId(5), [
      "Swapped the renderer in `invoices/pdf.ts`. Two invoice snapshots differ in the footer's line height.",
    ]),
  }),
]);

/**
 * Builds the signal that was handed to the Task `task`, which the pane's
 * "You asked" reads: resolved by the handoff, `askedMinutes` after it was
 * raised, with the drawing's asker, kind and place, and its text as the
 * first block.
 */
const buildHandedSignal = (
  task: TrackingTask,
  number: number,
  askedMinutes: number,
  signal: Pick<Signal, "kind" | "asker" | "place"> & { readonly text: string },
): Signal => {
  const { text, ...fields } = signal;
  const handoff = task.handoffs[task.handoffs.length - 1]!;
  return buildSignal(number, askedMinutes, {
    ...fields,
    id: handoff.signalId,
    title: task.title,
    blocks: [{ type: "text", markdown: text }],
    status: "resolved",
    resolution: {
      kind: "decided",
      actionId: `${HAND_TO_ACTION_PREFIX}${task.latestRun.workflowId ?? ""}`,
      runId: handoff.runId,
      outcome: `Handed to ${task.latestRun.workflowName}`,
      actor: "user",
      origin: "web",
      at: handoff.at,
    },
  });
};

/**
 * The signals handed to the tracked Tasks above, as `signal.read` returns
 * them: what each Task's "You asked" shows. They are not on To do or Done.
 * Each was raised at the time the drawing gives (`asked.at`).
 */
export const HANDED_SIGNALS: ReadonlyArray<Signal> = [
  buildHandedSignal(RATE_LIMIT, 51, 36, {
    kind: "github/review-requested",
    asker: "Marta",
    place: "payments-api #1296",
    text: "A token bucket per API key, 600 requests a minute, in Redis. Over the limit answers 429 with `Retry-After`.",
  }),
  buildHandedSignal(SDK, 52, 26, {
    kind: "github/assigned",
    asker: "Dependabot",
    place: "payments-api #1287",
    text: "stripe 13.11.0 → 14.2.0. Breaking: `PaymentIntent.charges` is removed; read `latest_charge` instead.",
  }),
  buildHandedSignal(REFUNDS, 53, 77, {
    kind: "linear/assigned",
    asker: "Jonas",
    place: "PAY-212",
    text: "Stripe lets us refund part of a captured payment. Support needs it for damaged items: refund one line, keep the order. The API shape is in PAY-214; build against it.",
  }),
  buildHandedSignal(BACKUP, 54, 37, {
    kind: "github/mentioned",
    asker: "Noor",
    place: "ops #88",
    text: "@rogier the backup has timed out three nights running, always on `events`. Can someone look before tonight's run?",
  }),
  buildHandedSignal(SKU, 55, 11, {
    kind: "linear/assigned",
    asker: "Pieter",
    place: "PAY-209",
    text: "Searching `ab-120` finds nothing; `AB-120` finds the product.",
  }),
  buildHandedSignal(PDF, 56, 65, {
    kind: "linear/assigned",
    asker: "Marta",
    place: "PAY-198",
    text: "Render invoices with the new renderer and drop wkhtmltopdf.",
  }),
];

/**
 * What a Tracking scene with the two Needs you rows holds, beside the
 * signals on To do (which must include the checks that failed on
 * `REFUNDS_PULL_REQUEST_REF`):
 *
 * - `tracking`: the drawing's seven rows;
 * - `agentSessions`: the session whose Request makes Upgrade the Stripe SDK Needs you;
 * - `yourWorkTasks`: the Task the failed checks are about, which makes Refunds for partial captures Needs you;
 * - `trackingDetails`: what the pane of each of those rows reads, except Split checkout into steps;
 * - `handedSignals`: the signal each of those rows was handed, which "You asked" reads.
 */
export const NEEDS_YOU_RECORDS: Partial<SidebarRecords> = {
  tracking: [REFUNDS, SDK, ...TRACKING_RECORDS],
  agentSessions: [SDK_SESSION],
  yourWorkTasks: [REFUNDS_TASK],
  trackingDetails: TRACKING_DETAILS,
  handedSignals: HANDED_SIGNALS,
};
