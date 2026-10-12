import { assert, describe, it } from "vitest";
import type {
  Agent,
  OpenRequest,
  Run,
  Session,
  StepRecord,
  Trigger,
  WorkflowDefinition,
} from "@hercule/contract";
import { buildGraphDrawing, buildRunOverlay } from "./graph-model";
import {
  buildNodeCard,
  buildRunNodeCard,
  describeNodeRunStatus,
  type NodeCard,
  type NodeCardReads,
  type RunNodeCardReads,
} from "./node-details";
import { buildInstance, buildSnapshot } from "./providers.testing";
import { buildSession } from "./threads/workspaces.testing";

const CREATED = "2026-09-01T09:00:00.000Z";

/**
 * A pull request's review: a label or the nightly schedule starts `review`,
 * which loops through `fix` until it approves; `open_pr` then opens the pull
 * request, and the run listens for it to be merged.
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
    {
      id: "review",
      kind: "agent",
      agent: "a-reviewer",
      prompt: "Review the change.",
      outputSchema: { type: "object", properties: { verdict: {}, notes: {} } },
    },
    {
      id: "fix",
      kind: "agent",
      agent: "a-coder",
      prompt: "Fix what the review found.",
      model: "claude-opus-5-5",
      accessMode: "auto",
      freshSession: true,
    },
    {
      id: "open_pr",
      kind: "action",
      action: "github/pr.create",
      params: { title: "Ship {{ inputs.version }}", draft: false },
      condition: "inputs.open",
      join: "all",
      terminal: true,
    },
  ],
  edges: [
    { from: "review", to: "fix", condition: 'steps.review.output.verdict == "changes"' },
    { from: "fix", to: "review", maxTraversals: 3 },
    { from: "review", to: "open_pr", condition: 'steps.review.output.verdict == "approved"' },
    { from: "merged", to: "review" },
  ],
};

/** Returns the record of the start trigger `triggerId` of the Review workflow. */
const buildTrigger = (triggerId: string, fields: Partial<Trigger>): Trigger => ({
  workflowId: "w-1",
  workflowName: "Review",
  triggerId,
  kind: "start",
  on: { schedule: "0 2 * * *" },
  status: "active",
  health: { state: "ok" },
  createdAt: CREATED,
  updatedAt: CREATED,
  ...fields,
});

const NIGHTLY = buildTrigger("nightly", {
  nextFireAt: "2026-09-30T02:00:00.000Z",
  lastFiredAt: "2026-09-29T02:00:00.000Z",
});

/** The reviewer runs on Opus, with approval required; `a-coder` is not an Agent. */
const REVIEWER: Pick<Agent, "id" | "name" | "instanceId" | "accessMode" | "model"> = {
  id: "a-reviewer",
  name: "Reviewer",
  instanceId: "instance-claude-code",
  accessMode: "approval-required",
  model: { model: "claude-opus-5", options: {} },
};

const READS: NodeCardReads = {
  triggers: [NIGHTLY],
  agents: [REVIEWER],
  actions: [],
  instances: [
    buildInstance("claude-code", "Claude Code", [
      buildSnapshot({
        models: [{ slug: "claude-opus-5", name: "Claude Opus 5", imageInput: null, options: [] }],
      }),
    ]),
  ],
  workflow: { enabled: true },
};

/** Builds the card of `nodeId`, failing the test when there is none. */
const buildCard = (nodeId: string, reads: NodeCardReads = READS): NodeCard => {
  const card = buildNodeCard(REVIEW, nodeId, reads);
  assert.isDefined(card, `no card for ${nodeId}`);
  return card;
};

/**
 * Returns a card's rows as label and value pairs: the value, the instant of a
 * time or start time row, or the start of an elapsed row.
 */
const listFacts = (card: NodeCard): Record<string, string> =>
  Object.fromEntries(
    card.facts.map((fact) => [
      fact.label,
      fact.kind === "text" ? fact.value : fact.kind === "elapsed" ? fact.startedAt : fact.at,
    ]),
  );

describe("buildNodeCard", () => {
  it("says which values an agent step takes from its Agent, and keeps the prompt apart", () => {
    const review = buildCard("review");
    assert.strictEqual(review.kindText, "Agent step");
    assert.isNull(review.firesOn);
    assert.strictEqual(review.prompt, "Review the change.");
    assert.deepStrictEqual(listFacts(review), {
      Agent: "Reviewer",
      Model: "Claude Opus 5, from the Agent",
      Access: "Approval required, from the Agent",
      Returns: "verdict, notes",
    });
  });

  it("shows an agent step's own values, and the id of an Agent that no longer exists", () => {
    // No catalog lists the step's model, so its slug shows.
    assert.deepStrictEqual(listFacts(buildCard("fix")), {
      Agent: "a-coder",
      Model: "claude-opus-5-5",
      Access: "Auto",
      Session: "A new one each time it runs",
    });
  });

  it("names an action step's action and lists its parameters and graph fields as code", () => {
    const openPr = buildCard("open_pr");
    assert.strictEqual(openPr.kindText, "Action step");
    assert.isUndefined(openPr.prompt);
    assert.deepStrictEqual(openPr.facts, [
      { kind: "text", label: "Action", value: "github/pr.create", isCode: false, isError: false },
      {
        kind: "text",
        label: "title",
        value: "Ship {{ inputs.version }}",
        isCode: true,
        isError: false,
      },
      { kind: "text", label: "draft", value: "false", isCode: true, isError: false },
      { kind: "text", label: "Runs if", value: "inputs.open", isCode: true, isError: false },
      {
        kind: "text",
        label: "Waits for",
        value: "Every step before it",
        isCode: false,
        isError: false,
      },
      {
        kind: "text",
        label: "Ends the run",
        value: "When it completes",
        isCode: false,
        isError: false,
      },
    ]);
  });

  it("gives a scheduled trigger's next and last fire as instants for the age clock", () => {
    const nightly = buildCard("nightly");
    assert.strictEqual(nightly.kindText, "Start trigger");
    assert.strictEqual(nightly.firesOn, "schedule");
    assert.deepStrictEqual(nightly.facts, [
      { kind: "text", label: "Fires on", value: "0 2 * * *", isCode: true, isError: false },
      { kind: "time", label: "Next", at: "2026-09-30T02:00:00.000Z", direction: "future" },
      { kind: "time", label: "Last fired", at: "2026-09-29T02:00:00.000Z", direction: "past" },
    ]);
  });

  it("leaves out the next fire of a paused trigger, and of any trigger while the workflow is disabled, invalid or not known", () => {
    const paused = buildCard("nightly", {
      ...READS,
      triggers: [{ ...NIGHTLY, status: "paused" }],
    });
    assert.deepStrictEqual(Object.keys(listFacts(paused)), ["Fires on", "Status", "Last fired"]);
    assert.strictEqual(listFacts(paused).Status, "Paused");
    const off = buildCard("nightly", { ...READS, workflow: { enabled: false } });
    assert.deepStrictEqual(Object.keys(listFacts(off)), ["Fires on", "Last fired"]);
    const invalid = buildCard("nightly", {
      ...READS,
      workflow: { enabled: true, invalidSince: CREATED },
    });
    assert.deepStrictEqual(Object.keys(listFacts(invalid)), ["Fires on", "Last fired"]);
    const unknown = buildCard("nightly", { ...READS, workflow: undefined });
    assert.deepStrictEqual(Object.keys(listFacts(unknown)), ["Fires on", "Last fired"]);
  });

  it("shows an event trigger's kind in words and its filter as code", () => {
    assert.strictEqual(buildCard("labeled").firesOn, "event");
    assert.deepStrictEqual(buildCard("labeled").facts, [
      {
        kind: "text",
        label: "Fires on",
        value: "github.issue.labeled",
        isCode: false,
        isError: false,
      },
      {
        kind: "text",
        label: "Filter",
        value: 'event.payload.label == "ship"',
        isCode: true,
        isError: false,
      },
    ]);
  });

  it("shows a signal's event and the values it matches", () => {
    const merged = buildCard("merged");
    assert.strictEqual(merged.kindText, "Signal trigger");
    assert.deepStrictEqual(listFacts(merged), {
      "Listens for": "github.pr.merged",
      Matches: "event.payload.number == steps.open_pr.output.number",
    });
  });

  it("has no card for an id the definition does not have", () => {
    assert.isUndefined(buildNodeCard(REVIEW, "start bus", READS));
  });

  it("shows no run on the workflow's own graph", () => {
    assert.isNull(buildCard("review").run);
    assert.isNull(buildCard("nightly").run);
  });
});

describe("buildRunNodeCard", () => {
  const START = "2026-09-24T12:00:00.000Z";
  const at = (ms: number): string => new Date(Date.parse(START) + ms).toISOString();
  const RUN_ID = "01a06d02-c111-7a0e-8b3d-9c1f1f3a9c2e";
  const REVIEW_SESSION_ID = "01a06d02-c111-7a0e-8b3d-9c1f00005e55";
  const FIX_SESSION_ID = "01a06d02-c111-7a0e-8b3d-9c1f00005e56";
  const SECOND_FIX_SESSION_ID = "01a06d02-c111-7a0e-8b3d-9c1f00005e57";

  /** Returns a completed record of `stepId`'s visit `iteration`, from `from` to `to` seconds after the start. */
  const complete = (stepId: string, iteration: number, from: number, to: number): StepRecord => ({
    stepId,
    iteration,
    status: "completed",
    startedAt: at(from * 1000),
    finishedAt: at(to * 1000),
    output: { verdict: "changes" },
  });

  /**
   * The label started the run; `review` asked for changes, `fix` made them,
   * and `review` runs again in the same session. The edges by index:
   * 0 review>fix, 1 fix>review, 2 review>open_pr, 3 merged>review.
   */
  const RUN_FIELDS = {
    id: RUN_ID,
    workflowId: null,
    plan: REVIEW,
    inputs: {},
    origin: { kind: "trigger", triggerId: "labeled", eventId: 1 },
    subscriptions: [],
    createdAt: START,
  } as const;

  const REVIEWING: Run = {
    ...RUN_FIELDS,
    status: "running",
    startedAt: START,
    steps: [
      { ...complete("review", 1, 0, 60), sessionId: REVIEW_SESSION_ID },
      {
        stepId: "fix",
        iteration: 1,
        status: "completed",
        startedAt: at(65_000),
        finishedAt: at(125_000),
        input: "Fix the failing\n  tests.",
        output: { files: 2 },
        sessionId: FIX_SESSION_ID,
      },
      {
        stepId: "review",
        iteration: 2,
        status: "running",
        startedAt: at(130_000),
        sessionId: REVIEW_SESSION_ID,
      },
    ],
    edgeTraversals: [1, 1, 0, 0],
  };

  const COMMAND_REQUEST: OpenRequest = {
    requestId: "r-1",
    itemId: "tool-1",
    decisions: ["allow", "deny"],
    kind: "command_approval",
    detail: { command: "npm audit fix --force" },
  };

  /** The reviewer's session: it reports exact usage and its cost, and asks to run a command. */
  const REVIEW_SESSION: Session = buildSession({
    id: REVIEW_SESSION_ID,
    runId: RUN_ID,
    stepId: "review",
    instanceId: "instance-claude-code",
    modelSelection: { model: "claude-opus-5", options: {} },
    toolCalls: 7,
    usage: { inputTokens: 30_000, outputTokens: 11_000, cacheReadTokens: 700, costUsd: 0.42 },
    openRequests: [COMMAND_REQUEST],
  });

  /** The fixer's session: its count misses some model calls, and it reports no cost. */
  const FIX_SESSION: Session = buildSession({
    id: FIX_SESSION_ID,
    runId: RUN_ID,
    stepId: "fix",
    modelSelection: { model: "claude-opus-5-5", options: {} },
    toolCalls: 3,
    usageReport: { status: "incomplete", counts: { inputTokens: 1_000, outputTokens: 500 } },
  });

  /** Returns the reads of the card of `run`'s node, with the overlay built from the same run and sessions. */
  const buildReads = (run: Run, sessions: ReadonlyArray<Session>): RunNodeCardReads => ({
    ...READS,
    run,
    sessions,
    overlay: buildRunOverlay(buildGraphDrawing(run.plan, [], []), run, sessions),
  });

  /** Builds the card of `nodeId` on `run`'s page, failing the test when there is none. */
  const buildRunCard = (
    nodeId: string,
    run: Run = REVIEWING,
    sessions: ReadonlyArray<Session> = [REVIEW_SESSION, FIX_SESSION],
  ): NodeCard => {
    const card = buildRunNodeCard(nodeId, buildReads(run, sessions));
    assert.isDefined(card, `no card for ${nodeId}`);
    return card;
  };

  it("shows a waiting step's question, its current visit, what its session used, and every visit", () => {
    const review = buildRunCard("review");
    assert.strictEqual(review.kindText, "Agent step");
    assert.strictEqual(review.prompt, "Review the change.");
    assert.deepStrictEqual(review.facts, [
      { kind: "startTime", label: "Started", at: at(130_000) },
      { kind: "elapsed", label: "Running for", startedAt: at(130_000), finishedAt: undefined },
      { kind: "text", label: "Model", value: "Claude Opus 5", isCode: false, isError: false },
      { kind: "text", label: "Tokens", value: "41.7k", isCode: false, isError: false },
      { kind: "text", label: "Tool calls", value: "7", isCode: false, isError: false },
      { kind: "text", label: "Cost", value: "$0.42", isCode: false, isError: false },
    ]);
    assert.deepStrictEqual(review.run, {
      state: "waiting",
      statusText: "Waiting on you",
      question: "Run npm audit fix --force?",
      visits: [
        {
          number: 1,
          state: "done",
          text: "Done",
          startedAt: START,
          finishedAt: at(60_000),
          // Both visits drive the same session, so both open it.
          sessionId: REVIEW_SESSION_ID,
        },
        {
          number: 2,
          state: "waiting",
          text: "Waiting on you",
          startedAt: at(130_000),
          finishedAt: undefined,
          sessionId: REVIEW_SESSION_ID,
        },
      ],
      sessionId: REVIEW_SESSION_ID,
    });
  });

  it("asks nothing while the step's session has no open Request", () => {
    const quiet = buildRunCard("review", REVIEWING, [{ ...REVIEW_SESSION, openRequests: [] }]);
    assert.strictEqual(quiet.run?.statusText, "Working");
    assert.isUndefined(quiet.run?.question);
  });

  it("shows a done step's time taken, its input on one line, and its output as JSON", () => {
    const fix = buildRunCard("fix");
    assert.deepStrictEqual(fix.facts, [
      { kind: "startTime", label: "Started", at: at(65_000) },
      { kind: "elapsed", label: "Took", startedAt: at(65_000), finishedAt: at(125_000) },
      {
        kind: "text",
        label: "Input",
        value: "Fix the failing tests.",
        isCode: false,
        isError: false,
      },
      { kind: "text", label: "Output", value: '{"files":2}', isCode: true, isError: false },
      // No catalog lists the model, so its slug shows.
      { kind: "text", label: "Model", value: "claude-opus-5-5", isCode: false, isError: false },
      { kind: "text", label: "Tokens", value: "1.5k (incomplete)", isCode: false, isError: false },
      { kind: "text", label: "Tool calls", value: "3", isCode: false, isError: false },
    ]);
    assert.deepStrictEqual(fix.run, {
      state: "done",
      statusText: "Done",
      question: undefined,
      // One visit lists none.
      visits: [],
      sessionId: FIX_SESSION_ID,
    });
  });

  it("says Not reported for tokens when a session reports none, never 0", () => {
    const silent = buildSession({ id: FIX_SESSION_ID, runId: RUN_ID, stepId: "fix", toolCalls: 3 });
    const fix = buildRunCard("fix", REVIEWING, [REVIEW_SESSION, silent]);
    assert.deepInclude(fix.facts, {
      kind: "text",
      label: "Tokens",
      value: "Not reported",
      isCode: false,
      isError: false,
    });
    assert.notInclude(
      fix.facts.map((fact) => fact.label),
      "Cost",
    );
  });

  it("adds up the sessions of a step that starts a new one each visit, and lists each visit's", () => {
    const second: Session = {
      ...FIX_SESSION,
      id: SECOND_FIX_SESSION_ID,
      toolCalls: 4,
      usageReport: { status: "complete", counts: { inputTokens: 2_000, outputTokens: 0 } },
      usage: { inputTokens: 2_000, outputTokens: 0 },
    };
    const twice: Run = {
      ...REVIEWING,
      steps: [
        ...REVIEWING.steps.slice(0, 2),
        { ...complete("review", 2, 130, 150), sessionId: REVIEW_SESSION_ID },
        { ...complete("fix", 2, 155, 200), sessionId: SECOND_FIX_SESSION_ID },
      ],
    };
    const fix = buildRunCard("fix", twice, [REVIEW_SESSION, FIX_SESSION, second]);
    assert.deepInclude(fix.facts, {
      kind: "text",
      label: "Tool calls",
      value: "7",
      isCode: false,
      isError: false,
    });
    assert.deepInclude(fix.facts, {
      kind: "text",
      label: "Tokens",
      value: "3.5k (incomplete)",
      isCode: false,
      isError: false,
    });
    assert.deepStrictEqual(
      fix.run?.visits.map((visit) => [visit.number, visit.text, visit.sessionId]),
      [
        [1, "Done", FIX_SESSION_ID],
        [2, "Done", SECOND_FIX_SESSION_ID],
      ],
    );
    assert.strictEqual(fix.run?.sessionId, SECOND_FIX_SESSION_ID);
  });

  it("gives a visit that has no session yet no session to open", () => {
    const third: Run = {
      ...REVIEWING,
      steps: [
        ...REVIEWING.steps.slice(0, 2),
        { ...complete("review", 2, 130, 150), sessionId: REVIEW_SESSION_ID },
        { ...complete("fix", 2, 155, 200), sessionId: SECOND_FIX_SESSION_ID },
        { stepId: "fix", iteration: 3, status: "pending" },
      ],
    };
    const fix = buildRunCard("fix", third, [REVIEW_SESSION, FIX_SESSION]);
    assert.deepStrictEqual(
      fix.run?.visits.map((visit) => [visit.number, visit.text, visit.sessionId]),
      [
        [1, "Done", FIX_SESSION_ID],
        [2, "Done", SECOND_FIX_SESSION_ID],
        [3, "Waiting to start", undefined],
      ],
    );
  });

  it("shows a failed step's error in the fail ink", () => {
    const failed: Run = {
      ...RUN_FIELDS,
      status: "failed",
      failureReason: "step-failed",
      failedStepId: "open_pr",
      startedAt: START,
      finishedAt: at(300_000),
      steps: [
        { ...complete("review", 1, 0, 60), sessionId: REVIEW_SESSION_ID },
        {
          stepId: "open_pr",
          iteration: 1,
          status: "failed",
          startedAt: at(70_000),
          finishedAt: at(80_000),
          error: { code: "github_error", message: "The branch is protected." },
        },
      ],
      edgeTraversals: [0, 0, 1, 0],
    };
    const openPr = buildRunCard("open_pr", failed, []);
    assert.strictEqual(openPr.run?.statusText, "Failed");
    assert.deepStrictEqual(openPr.facts.at(-1), {
      kind: "text",
      label: "Error",
      value: "The branch is protected.",
      isCode: false,
      isError: true,
    });
  });

  it("says a step the run has not reached was not reached, with no rows but its prompt", () => {
    const openPr = buildRunCard("open_pr");
    assert.deepStrictEqual(openPr.facts, []);
    assert.deepStrictEqual(openPr.run, {
      state: "unreached",
      statusText: "Not reached in this run",
      question: undefined,
      visits: [],
      sessionId: undefined,
    });
  });

  it("says whether a start trigger started the run, and keeps its declaration and next fire", () => {
    const labeled = buildRunCard("labeled");
    assert.strictEqual(labeled.run?.statusText, "Started this run");
    assert.deepStrictEqual(labeled.facts, [
      {
        kind: "text",
        label: "Fires on",
        value: "github.issue.labeled",
        isCode: false,
        isError: false,
      },
      {
        kind: "text",
        label: "Filter",
        value: 'event.payload.label == "ship"',
        isCode: true,
        isError: false,
      },
    ]);
    const nightly = buildRunCard("nightly");
    assert.strictEqual(nightly.run?.statusText, "Did not start this run");
    assert.deepStrictEqual(nightly.facts, [
      { kind: "text", label: "Fires on", value: "0 2 * * *", isCode: true, isError: false },
      { kind: "time", label: "Next", at: "2026-09-30T02:00:00.000Z", direction: "future" },
    ]);
  });

  it("leaves out a start trigger's next fire while the workflow is invalid", () => {
    const nightly = buildRunNodeCard("nightly", {
      ...buildReads(REVIEWING, [REVIEW_SESSION, FIX_SESSION]),
      workflow: { enabled: true, invalidSince: CREATED },
    });
    assert.deepStrictEqual(nightly?.facts, [
      { kind: "text", label: "Fires on", value: "0 2 * * *", isCode: true, isError: false },
    ]);
  });

  it("says whether the run listens for a signal", () => {
    assert.strictEqual(buildRunCard("merged").run?.statusText, "Has not fired");
    const opened: Run = {
      ...REVIEWING,
      steps: [
        { ...complete("review", 1, 0, 60), sessionId: REVIEW_SESSION_ID },
        complete("open_pr", 1, 70, 80),
      ],
      edgeTraversals: [0, 0, 1, 0],
    };
    const merged = buildRunCard("merged", opened, []);
    assert.strictEqual(merged.run?.statusText, "Listening for its event");
    assert.deepStrictEqual(Object.keys(listFacts(merged)), ["Listens for", "Matches"]);
  });

  it("has no card for an id the plan does not have", () => {
    assert.isUndefined(buildRunNodeCard("start bus", buildReads(REVIEWING, [])));
  });
});

describe("describeNodeRunStatus", () => {
  it("gives the status line of a step's state", () => {
    assert.strictEqual(
      describeNodeRunStatus("skipped", "agent"),
      "Skipped: its condition was false",
    );
    assert.strictEqual(describeNodeRunStatus("waiting", "agent"), "Waiting on you");
    assert.strictEqual(describeNodeRunStatus("pending", "action"), "Waiting to start");
  });

  it("reads a signal trigger's states as firing and listening", () => {
    assert.strictEqual(describeNodeRunStatus("fired", "signal"), "Fired");
    assert.strictEqual(describeNodeRunStatus("listening", "signal"), "Listening for its event");
    assert.strictEqual(describeNodeRunStatus("quiet", "signal"), "Has not fired");
  });

  it("reads a start trigger's states as starting the run or not", () => {
    assert.strictEqual(describeNodeRunStatus("fired", "start"), "Started this run");
    assert.strictEqual(describeNodeRunStatus("quiet", "start"), "Did not start this run");
  });
});
