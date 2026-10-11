/**
 * The records of the run specimen (run.tsx): two runs of Ship release as
 * the Bureau book's run page draws them (docs/design/crew-bureau-2/desktop/
 * run.html, its data in workflows.js's `RUNS`), as the controller would
 * return them at the specimen's clock, Tuesday 29 September 2026, 09:41 UTC.
 * `pnpm compare:bureau` compares the page the app builds from them with the
 * book's page.
 *
 * The runs are the book's `?state=` runs, each written below as the book
 * writes its step timeline: one step record per row, in the row's order,
 * which is the order the records were created, with its start and end in
 * minutes after the run started. From those minutes come the records'
 * timestamps, and from the rows' counts the runs' edge traversals:
 *
 * - `waiting`, the book's default: started by release_issue today at 09:12,
 *   and still running. Its security step's session waits on the user to
 *   allow `npm audit fix --force`, and open_pr waits for security. It
 *   works in a workspace of its own, which the app draws as a Workspace row
 *   that the book's page does not have (run-reference.ts adds it);
 * - `failed`: started by release_train on Friday 25 September at 14:00, and
 *   failed after 40 minutes at the iteration limit of the review loop.
 *
 * Each record drives a session of its own, so a node's card lists one thread
 * per time the run came to the step. Each session reports the tokens, tool
 * calls and cost the book's cards show, a step's sessions adding up to its
 * card's numbers.
 *
 * The run ids, the workflow and its plan are those of the Workflows
 * specimen's Ship release (workflows-fixture.ts), so both specimens describe
 * the same runs. The plan is parsed from the workflow's source, as the
 * controller froze it when each run started.
 */
import type { Run, RunSummary, Session, StepRecord, Usage, Workspace } from "@hercule/contract";
import { parseWorkflowSourceWithRanges } from "@hercule/client-core";
import { buildCheckout, buildWorkspace } from "@hercule/client-core/threads/testing";
import { buildSpecimenSession, CLAUDE_SONNET, STUDIO_MAC } from "./sidebar-fixture";
import { WORKFLOWS_RECORDS } from "./workflows-fixture";

/** What a completed step record holds as its step's output. */
type StepOutput = Extract<StepRecord, { status: "completed" }>["output"];

/** One step record of a fixture run, one row of the book's step timeline. */
interface FixtureStepRecord {
  readonly stepId: string;
  /** When the record started, in minutes after the run started. None for a pending record. */
  readonly startMinute?: number;
  /** When the record finished, in minutes after the run started. None for a record still running or pending. */
  readonly endMinute?: number;
  /** What the record's step returned. Given only for a completed record. */
  readonly output?: StepOutput;
  /** What the record's session used. None for a record that has no session yet. */
  readonly session?: {
    readonly tokens: number;
    readonly toolCalls: number;
    readonly costUsd: number;
  };
}

/** One run of Ship release as the book's run page draws it. */
interface FixtureRun {
  /** When the run was created and started, an ISO instant. */
  readonly createdAt: string;
  /** The start trigger that started the run. */
  readonly triggerId: string;
  readonly version: string;
  /** The records, in the order they were created. */
  readonly records: ReadonlyArray<FixtureStepRecord>;
  /** How many times the run followed each edge of the plan, in the plan's order. */
  readonly edgeTraversals: ReadonlyArray<number>;
  /** The run's workspace. None for a run that has none. */
  readonly workspace?: Workspace;
}

/**
 * The waiting run's workspace: its own branch of the repo, cleaned up
 * automatically when the run ends. The book's Cancel run dialog offers to
 * delete it, which the app offers only for such a workspace.
 */
const RELEASE_WORKSPACE: Workspace = buildWorkspace({
  id: "w-release",
  runnerId: STUDIO_MAC.id,
  kind: "ephemeral",
  retentionPolicy: "automatic",
  checkouts: [
    {
      ...buildCheckout("r-hercule", "release/2.14.0", ["main", "release/2.14.0"]),
      form: "worktree",
      startingRevision: { kind: "remote", branch: "main" },
    },
  ],
});

/** The waiting run: today at 09:12, its security step waiting on the user for 29 minutes. */
const WAITING_RUN: FixtureRun = {
  createdAt: "2026-09-29T09:12:00.000Z",
  triggerId: "release_issue",
  version: "2.14.0",
  records: [
    {
      stepId: "changelog",
      startMinute: 0,
      endMinute: 3,
      output: { changelog: "…" },
      session: { tokens: 49_700, toolCalls: 46, costUsd: 0.12 },
    },
    {
      stepId: "test",
      startMinute: 0,
      endMinute: 8,
      output: { passed: true },
      session: { tokens: 49_800, toolCalls: 47, costUsd: 0.12 },
    },
    {
      stepId: "security",
      startMinute: 0,
      session: { tokens: 49_900, toolCalls: 2, costUsd: 0.12 },
    },
    {
      stepId: "review",
      startMinute: 0,
      endMinute: 5,
      output: { verdict: "changes" },
      session: { tokens: 24_800, toolCalls: 22, costUsd: 0.06 },
    },
    {
      stepId: "fix",
      startMinute: 5,
      endMinute: 15,
      output: { commits: 2 },
      session: { tokens: 50_000, toolCalls: 3, costUsd: 0.12 },
    },
    {
      stepId: "review",
      startMinute: 15,
      endMinute: 19,
      output: { verdict: "approved" },
      session: { tokens: 24_800, toolCalls: 23, costUsd: 0.06 },
    },
    { stepId: "open_pr" },
  ],
  // changelog, security and test to open_pr; review to open_pr and to fix;
  // fix to review; pr_merged to announce; announce to notify.
  edgeTraversals: [1, 0, 1, 1, 1, 1, 0, 0],
  workspace: RELEASE_WORKSPACE,
};

/**
 * Returns the records of one turn of the failed run's review loop, review
 * then fix, from `startMinute`. The fix's session made `fixToolCalls` tool
 * calls and cost `fixCostUsd`, so the three fixes add up to the book's card.
 */
const buildReviewLoop = (
  startMinute: number,
  fixToolCalls: number,
  fixCostUsd: number,
): ReadonlyArray<FixtureStepRecord> => [
  {
    stepId: "review",
    startMinute,
    endMinute: startMinute + 4,
    output: { verdict: "changes" },
    session: { tokens: 13_600, toolCalls: 12, costUsd: 0.03 },
  },
  {
    stepId: "fix",
    startMinute: startMinute + 4,
    endMinute: startMinute + 12,
    output: { commits: 1 },
    session: { tokens: 18_200, toolCalls: fixToolCalls, costUsd: fixCostUsd },
  },
];

/** The failed run: Friday 25 September at 14:00, failed at the review loop's limit after 40 minutes. */
const FAILED_RUN: FixtureRun = {
  createdAt: "2026-09-25T14:00:00.000Z",
  triggerId: "release_train",
  version: "2.13.0",
  records: [
    {
      stepId: "changelog",
      startMinute: 0,
      endMinute: 4,
      output: { changelog: "…" },
      session: { tokens: 54_700, toolCalls: 3, costUsd: 0.14 },
    },
    {
      stepId: "security",
      startMinute: 0,
      endMinute: 6,
      output: { findings: 0 },
      session: { tokens: 54_800, toolCalls: 4, costUsd: 0.14 },
    },
    {
      stepId: "test",
      startMinute: 0,
      endMinute: 9,
      output: { passed: true },
      session: { tokens: 54_900, toolCalls: 5, costUsd: 0.14 },
    },
    ...buildReviewLoop(0, 1, 0.05),
    ...buildReviewLoop(12, 1, 0.05),
    ...buildReviewLoop(24, 0, 0.04),
    {
      stepId: "review",
      startMinute: 36,
      endMinute: 40,
      output: { verdict: "changes" },
      session: { tokens: 13_700, toolCalls: 11, costUsd: 0.04 },
    },
  ],
  edgeTraversals: [1, 1, 1, 0, 3, 3, 0, 0],
};

/**
 * The edge the failed run failed at, as the book draws it: review to fix,
 * the plan's edge 4, with the book's sentence. The book fails the run at
 * review, before it would follow review → fix a fourth time. The controller
 * checks a limit on the edge that has it, fix → review (edge 5), so it would
 * have run fix a fourth time and failed at fix, with a sentence of its own.
 * The fixture keeps the book's reading, which the contract allows, so that
 * the two pages draw the same run.
 */
const FAILED_EDGE = {
  index: 4,
  message: "The run would follow review → fix a fourth time, past its limit of 3.",
};

/** Returns the moment `minutes` minutes after `instant`, an ISO instant. */
const addMinutes = (instant: string, minutes: number): string =>
  new Date(Date.parse(instant) + minutes * 60_000).toISOString();

/** Returns the id of session `number` of the run specimen. */
const buildSessionId = (number: number): string =>
  `01a06d02-7b00-7000-8000-${String(number).padStart(12, "0")}`;

/** Splits `tokens` into the Token Usage a session reports: a fifth output, the rest input. */
const buildUsage = (tokens: number, costUsd: number): Usage => {
  const outputTokens = Math.round(tokens / 5);
  return { inputTokens: tokens - outputTokens, outputTokens, costUsd };
};

/** Returns the run summary of Ship release created at `createdAt`, from the Workflows specimen. Fails when there is none. */
const findRunSummary = (createdAt: string): RunSummary => {
  const summary = WORKFLOWS_RECORDS.openWorkflow.runs.find((run) => run.createdAt === createdAt);
  if (summary === undefined) {
    throw new Error(`The Workflows fixture has no run of Ship release created at ${createdAt}.`);
  }
  return summary;
};

/** Parses Ship release's source into the plan its runs froze. Fails when the source does not parse. */
const parsePlan = (): Run["plan"] => {
  const { definition, issues } = parseWorkflowSourceWithRanges(
    WORKFLOWS_RECORDS.openWorkflow.workflow.source,
  );
  if (definition === undefined) {
    throw new Error(
      `Ship release's source does not parse: ${issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return definition;
};

/** The step whose session waits on the user in the waiting run, and the command it asks to run. */
const WAITING_REQUEST = { stepId: "security", command: "npm audit fix --force" };

/** A run of the specimen, and the sessions its agent steps drive. */
export interface RunRecords {
  /** The run, as `run.read` returns it. */
  readonly run: Run;
  /** The run's sessions, oldest first, as `session.query({ runId })` lists them. */
  readonly sessions: ReadonlyArray<Session>;
  /** The workspaces `workspace.query` lists for the run: its own, or none. */
  readonly workspaces: ReadonlyArray<Workspace>;
}

/** Builds the run `fixture` stands for, numbering its sessions from `firstSession`. */
const buildRunRecords = (fixture: FixtureRun, firstSession: number): RunRecords => {
  const summary = findRunSummary(fixture.createdAt);
  const { origin } = summary;
  if (origin.kind !== "trigger" || origin.triggerId !== fixture.triggerId) {
    throw new Error(
      `The Workflows fixture's run created at ${fixture.createdAt} was not started by ${fixture.triggerId}.`,
    );
  }
  const plan = parsePlan();
  const agentIds = new Map(
    plan.steps.flatMap((step) => (step.kind === "agent" ? [[step.id, step.agent]] : [])),
  );
  const iterations = new Map<string, number>();
  const sessions: Session[] = [];
  const steps = fixture.records.map((record): StepRecord => {
    const iteration = (iterations.get(record.stepId) ?? 0) + 1;
    iterations.set(record.stepId, iteration);
    const fields = { stepId: record.stepId, iteration };
    if (record.startMinute === undefined) return { ...fields, status: "pending" };
    const startedAt = addMinutes(fixture.createdAt, record.startMinute);
    const finishedAt =
      record.endMinute === undefined ? null : addMinutes(fixture.createdAt, record.endMinute);
    let sessionId: string | undefined;
    if (record.session !== undefined) {
      sessionId = buildSessionId(firstSession + sessions.length);
      const isAsking = finishedAt === null && record.stepId === WAITING_REQUEST.stepId;
      sessions.push(
        buildSpecimenSession({
          id: sessionId,
          title: `Ship release · ${record.stepId}`,
          minutesAgo: 0,
          model: CLAUDE_SONNET,
          status: finishedAt === null ? "busy" : "exited",
          agentId: agentIds.get(record.stepId) ?? null,
          runId: summary.id,
          stepId: record.stepId,
          createdAt: startedAt,
          startedAt,
          exitedAt: finishedAt,
          lastActivityAt: finishedAt ?? startedAt,
          usage: buildUsage(record.session.tokens, record.session.costUsd),
          toolCalls: record.session.toolCalls,
          openRequests: isAsking
            ? [
                {
                  requestId: "r-security",
                  itemId: "tool-security",
                  decisions: ["allow", "deny"],
                  kind: "command_approval",
                  detail: { command: WAITING_REQUEST.command },
                },
              ]
            : [],
        }),
      );
    }
    const withSession = { ...fields, ...(sessionId !== undefined && { sessionId }) };
    if (finishedAt === null) return { ...withSession, status: "running", startedAt };
    return {
      ...withSession,
      status: "completed",
      startedAt,
      finishedAt,
      output: record.output ?? null,
    };
  });

  const shared = {
    id: summary.id,
    workflowId: summary.workflowId,
    plan,
    inputs: { version: fixture.version },
    origin,
    steps,
    edgeTraversals: fixture.edgeTraversals,
    subscriptions: [],
    createdAt: fixture.createdAt,
    ...(fixture.workspace !== undefined && { workspaceId: fixture.workspace.id }),
  };
  const workspaces = fixture.workspace === undefined ? [] : [fixture.workspace];
  switch (summary.status) {
    case "running":
      return {
        run: { ...shared, status: "running", startedAt: summary.startedAt },
        sessions,
        workspaces,
      };
    case "failed":
      return {
        run: {
          ...shared,
          status: "failed",
          failureReason: "iteration-limit",
          failedStepId: "review",
          failedEdge: FAILED_EDGE,
          startedAt: fixture.createdAt,
          finishedAt: summary.finishedAt,
        },
        sessions,
        workspaces,
      };
    default:
      throw new Error(`The run specimen has no ${summary.status} run.`);
  }
};

/** The runs the book's run page draws, by the `?state=` that picks each. */
export const RUN_RECORDS = {
  waiting: buildRunRecords(WAITING_RUN, 1),
  failed: buildRunRecords(FAILED_RUN, 101),
} as const satisfies Record<string, RunRecords>;

/** The names of the runs the specimen can draw, as the book's `?state=` names them. */
export type RunState = keyof typeof RUN_RECORDS;
