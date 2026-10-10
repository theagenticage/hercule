import { describe, expect, it } from "vitest";
import { buildSession } from "@hercule/client-core/threads/testing";
import type {
  Agent,
  ProviderInstance,
  Run,
  Session,
  StepRecord,
  Trigger,
  WorkflowDefinition,
} from "@hercule/contract";
import { FIXTURE_INSTANCE } from "../../app/testing";
import { buildGraphDrawing } from "./graph-model";
import { buildNodeDetails, type NodeDetails } from "./node-details";
import type { SessionWithToolCalls } from "./proposed-contract";

const STARTED = "2026-09-29T09:00:00.000Z";
const FINISHED = "2026-09-29T09:02:30.000Z";
const NOW = new Date("2026-09-29T09:10:00.000Z");

/**
 * A pull request's review: a label starts `review`, which loops through
 * `fix` until it approves; `open_pr` then opens the pull request, and the
 * run listens for it to be merged.
 */
const REVIEW: WorkflowDefinition = {
  name: "Review",
  triggers: [
    {
      id: "labeled",
      kind: "start",
      on: { kind: "github.issue.labeled", filter: 'event.payload.label == "ship"' },
    },
    { id: "nightly", kind: "start", on: { schedule: "0 2 * * *" } },
    {
      id: "merged",
      kind: "signal",
      on: { kind: "github.pr.merged" },
      correlation: { event: "event.payload.number", run: "steps.open_pr.output.number" },
    },
  ],
  steps: [
    { id: "review", kind: "agent", agent: "a-reviewer", prompt: "Review the change." },
    {
      id: "fix",
      kind: "agent",
      agent: "a-coder",
      prompt: "Fix what the review found.",
      model: "claude-opus-5-5",
      freshSession: true,
    },
    { id: "open_pr", kind: "action", action: "github/pr.create" },
  ],
  edges: [
    { from: "review", to: "fix", condition: 'steps.review.output.verdict == "changes"' },
    { from: "fix", to: "review", maxTraversals: 3 },
    { from: "review", to: "open_pr", condition: 'steps.review.output.verdict == "approved"' },
    { from: "merged", to: "review" },
  ],
};

/** The instance every session runs on, whose catalog names `claude-sonnet-5` and `claude-opus-5`. */
const INSTANCES: ReadonlyArray<ProviderInstance> = [{ ...FIXTURE_INSTANCE, id: "i-claude" }];

/** The reviewer runs on Opus; `a-coder` is not an Agent of the fixture. */
const AGENTS: ReadonlyArray<Agent> = [
  {
    id: "a-reviewer",
    name: "Reviewer",
    systemPrompt: "You review changes.",
    instanceId: "i-claude",
    permissionProfileId: "p-unrestricted",
    accessMode: "approval-required",
    model: { model: "claude-opus-5", options: {} },
    disallowedTools: [],
    unenforced: [],
    createdAt: STARTED,
    updatedAt: STARTED,
  },
];

/** Returns a completed step record of `stepId`, driving `sessionId` when one is given. */
const complete = (
  stepId: string,
  iteration: number,
  sessionId?: string,
  output: Extract<StepRecord, { status: "completed" }>["output"] = null,
): StepRecord => ({
  stepId,
  iteration,
  status: "completed",
  startedAt: STARTED,
  finishedAt: FINISHED,
  output,
  ...(sessionId === undefined ? {} : { sessionId }),
});

/** The fields of a run that no test here reads. */
const RUN_FIELDS = {
  id: "r-1",
  workflowId: "w-1",
  plan: REVIEW,
  inputs: {},
  origin: { kind: "trigger", triggerId: "labeled", eventId: 1 },
  subscriptions: [],
  createdAt: STARTED,
  startedAt: STARTED,
  edgeTraversals: [2, 1, 0, 0],
} as const;

/** `review` looped through `fix` twice, and waits on the user on its third pass. */
const LOOPING: Run = {
  ...RUN_FIELDS,
  status: "running",
  steps: [
    complete("review", 1, "s-review", { verdict: "changes" }),
    complete("fix", 1, "s-fix-1"),
    complete("review", 2, "s-review", { verdict: "changes" }),
    complete("fix", 2, "s-fix-2"),
    {
      stepId: "review",
      iteration: 3,
      status: "running",
      startedAt: "2026-09-29T09:06:00.000Z",
      sessionId: "s-review",
    },
  ],
};

/** Returns a session of the run with `toolCalls`, as the proposed contract counts them. */
const buildStepSession = (
  overrides: Partial<Session> & { readonly id: string; readonly toolCalls: number },
): SessionWithToolCalls => ({ ...buildSession({ runId: "r-1", ...overrides }), ...overrides });

const REVIEW_SESSION = buildStepSession({
  id: "s-review",
  stepId: "review",
  toolCalls: 31,
  usage: { inputTokens: 30_000, outputTokens: 5_000, cacheReadTokens: 6_700, costUsd: 0.42 },
  modelSelection: { model: "claude-sonnet-5", options: {} },
  openRequests: [
    {
      requestId: "q-1",
      itemId: "i-1",
      kind: "command_approval",
      decisions: ["allow", "deny"],
      detail: { command: "git push" },
    },
  ],
});

const FIX_SESSIONS = [
  buildStepSession({
    id: "s-fix-1",
    stepId: "fix",
    toolCalls: 4,
    usage: { inputTokens: 900, outputTokens: 100 },
  }),
  buildStepSession({
    id: "s-fix-2",
    stepId: "fix",
    toolCalls: 6,
    usageReport: { status: "incomplete", counts: { inputTokens: 1_500, outputTokens: 500 } },
  }),
];

const TRIGGERS: ReadonlyArray<Trigger> = [
  {
    workflowId: "w-1",
    workflowName: "Review",
    triggerId: "nightly",
    kind: "start",
    on: { schedule: "0 2 * * *" },
    status: "active",
    health: { state: "ok" },
    nextFireAt: "2026-09-30T02:00:00.000Z",
    lastFiredAt: "2026-09-29T02:00:00.000Z",
    createdAt: STARTED,
    updatedAt: STARTED,
  },
];

/** Builds the card of the node `id`, with `run` and `sessions` drawn. */
const describeNode = (
  id: string,
  run: Run | undefined,
  sessions: ReadonlyArray<Session> = [],
): NodeDetails => {
  const drawing = buildGraphDrawing(REVIEW, run, sessions, AGENTS, []);
  const records = {
    definition: REVIEW,
    run,
    sessions,
    triggers: TRIGGERS,
    agents: AGENTS,
    actions: [],
    instances: INSTANCES,
  };
  return buildNodeDetails(drawing, records, "UTC", NOW).get(id)!;
};

/** Returns the facts of a card as label-value pairs. */
const listFacts = (details: NodeDetails): Record<string, string> =>
  Object.fromEntries(details.facts.map((fact) => [fact.label, fact.value]));

describe("buildNodeDetails", () => {
  it("shows what a waiting agent step's session asks, what it used, and the session to open", () => {
    const review = describeNode("review", LOOPING, [REVIEW_SESSION, ...FIX_SESSIONS]);
    expect(review.status).toEqual({ mark: "waiting", text: "Waiting on you", tone: "you" });
    expect(review.question).toBe("Run git push?");
    expect(review.sessionId).toBe("s-review");
    expect(review.prompt).toBe("Review the change.");
    expect(listFacts(review)).toEqual({
      Model: "Claude Sonnet 5",
      // Three iterations drove one session, so its usage counts once.
      Tokens: "41.7k",
      "Tool calls": "31",
      Cost: "$0.42",
      Started: "Today 09:06",
      "Running for": "4m 0s",
    });
  });

  it("lists each iteration, without a session of its own when every iteration shares one", () => {
    const review = describeNode("review", LOOPING, [REVIEW_SESSION]);
    expect(review.iterations).toEqual([
      { number: 1, mark: "done", text: "Done", durationText: "2m 30s", sessionId: undefined },
      { number: 2, mark: "done", text: "Done", durationText: "2m 30s", sessionId: undefined },
      {
        number: 3,
        mark: "waiting",
        text: "Waiting on you",
        durationText: "4m 0s",
        sessionId: undefined,
      },
    ]);
  });

  it("adds up the sessions of a step that starts a new one each time, and links each iteration to its own", () => {
    const fix = describeNode("fix", LOOPING, FIX_SESSIONS);
    expect(fix.iterations.map((iteration) => iteration.sessionId)).toEqual(["s-fix-1", "s-fix-2"]);
    expect(fix.sessionId).toBe("s-fix-2");
    const facts = listFacts(fix);
    // The second session reports only an incomplete count, and neither a cost.
    expect(facts.Tokens).toBe("3.0k (incomplete)");
    expect(facts["Tool calls"]).toBe("10");
    expect(facts.Cost).toBeUndefined();
    // The latest session's model, as the instance's catalog names it.
    expect(facts.Model).toBe("Claude Sonnet 5");
  });

  it("says a count is not reported, never 0, when a session has none", () => {
    const silent = buildSession({ id: "s-review", runId: "r-1", stepId: "review" });
    const facts = listFacts(describeNode("review", LOOPING, [silent]));
    expect(facts.Tokens).toBe("Not reported");
    expect(facts["Tool calls"]).toBe("Not reported");
    expect(facts.Cost).toBeUndefined();
  });

  it("shows an action step's input and output, and a failed step's error in the fail tone", () => {
    const run: Run = {
      ...RUN_FIELDS,
      status: "failed",
      failureReason: "step-failed",
      failedStepId: "open_pr",
      finishedAt: FINISHED,
      steps: [
        complete("review", 1, "s-review", { verdict: "approved" }),
        {
          stepId: "open_pr",
          iteration: 1,
          status: "failed",
          input: { title: "Ship 1.4" },
          startedAt: STARTED,
          finishedAt: FINISHED,
          error: { code: "forbidden", message: "The token cannot open pull requests." },
        },
      ],
    };
    const openPr = describeNode("open_pr", run);
    expect(openPr.status).toEqual({ mark: "failed", text: "Failed", tone: "fail" });
    expect(openPr.facts).toEqual([
      { label: "Started", value: "Today 09:00", isCode: false, tone: undefined },
      { label: "Took", value: "2m 30s", isCode: false, tone: undefined },
      { label: "Input", value: '{"title":"Ship 1.4"}', isCode: true, tone: undefined },
      {
        label: "Error",
        value: "The token cannot open pull requests.",
        isCode: false,
        tone: "fail",
      },
    ]);
    expect(openPr.sessionId).toBeUndefined();
  });

  it("says which start trigger started the run, and when each fires", () => {
    expect(describeNode("labeled", LOOPING).status?.text).toBe("Started this run");
    const nightly = describeNode("nightly", LOOPING);
    expect(nightly.status?.text).toBe("Did not start this run");
    expect(listFacts(nightly)).toEqual({
      "Fires on": "0 2 * * *",
      Next: "Wed 02:00",
      "Last fired": "02:00",
    });
    // A cron expression is code, so it shows in the code face.
    expect(nightly.facts[0]?.isCode).toBe(true);
    expect(describeNode("labeled", undefined).facts[0]?.isCode).toBe(false);
    expect(describeNode("labeled", undefined).facts).toContainEqual({
      label: "Filter",
      value: 'event.payload.label == "ship"',
      isCode: true,
      tone: undefined,
    });
  });

  it("shows a signal's event and the values it matches", () => {
    expect(listFacts(describeNode("merged", undefined))).toEqual({
      "Listens for": "github.pr.merged",
      Matches: "event.payload.number == steps.open_pr.output.number",
    });
  });

  it("shows what a step's definition sets when the graph draws no run", () => {
    const fix = describeNode("fix", undefined);
    expect(fix.status).toBeUndefined();
    expect(fix.detail).toBe("Agent step");
    // `a-coder` is no Agent, so its id shows; no catalog names the step's
    // model, so its slug shows.
    expect(fix.facts).toEqual([
      { label: "Agent", value: "a-coder", isCode: false, tone: undefined },
      { label: "Model", value: "claude-opus-5-5", isCode: false, tone: undefined },
      { label: "Session", value: "A new one each time it runs", isCode: false, tone: undefined },
    ]);
    expect(fix.iterations).toEqual([]);
    expect(fix.sessionId).toBeUndefined();
  });

  it("says which values a step takes from its Agent", () => {
    expect(listFacts(describeNode("review", undefined))).toEqual({
      Agent: "Reviewer",
      Model: "Claude Opus 5, from the Agent",
      Access: "Approval required, from the Agent",
    });
  });

  it("names an action step's action, by its id when no action has it", () => {
    const openPr = describeNode("open_pr", undefined);
    expect(openPr.detail).toBe("Action step");
    expect(listFacts(openPr)).toEqual({ Action: "github/pr.create" });
  });
});
