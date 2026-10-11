import { assert, describe, it } from "vitest";
import type { Agent, Trigger, WorkflowDefinition } from "@hercule/contract";
import { buildNodeCard, type NodeCard, type NodeCardReads } from "./node-details";
import { buildInstance, buildSnapshot } from "./providers.testing";

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
  isWorkflowEnabled: true,
};

/** Builds the card of `nodeId`, failing the test when there is none. */
const buildCard = (nodeId: string, reads: NodeCardReads = READS): NodeCard => {
  const card = buildNodeCard(REVIEW, nodeId, reads);
  assert.isDefined(card, `no card for ${nodeId}`);
  return card;
};

/** Returns a card's rows as label and value pairs: the value, or the instant of a time row. */
const listFacts = (card: NodeCard): Record<string, string> =>
  Object.fromEntries(
    card.facts.map((fact) => [fact.label, fact.kind === "text" ? fact.value : fact.at]),
  );

describe("buildNodeCard", () => {
  it("says which values an agent step takes from its Agent, and keeps the prompt apart", () => {
    const review = buildCard("review");
    assert.strictEqual(review.kindText, "Agent step");
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
      { kind: "text", label: "Action", value: "github/pr.create", isCode: false },
      { kind: "text", label: "title", value: "Ship {{ inputs.version }}", isCode: true },
      { kind: "text", label: "draft", value: "false", isCode: true },
      { kind: "text", label: "Runs if", value: "inputs.open", isCode: true },
      { kind: "text", label: "Waits for", value: "Every step before it", isCode: false },
      { kind: "text", label: "Ends the run", value: "When it completes", isCode: false },
    ]);
  });

  it("gives a scheduled trigger's next and last fire as instants for the age clock", () => {
    const nightly = buildCard("nightly");
    assert.strictEqual(nightly.kindText, "Start trigger");
    assert.deepStrictEqual(nightly.facts, [
      { kind: "text", label: "Fires on", value: "0 2 * * *", isCode: true },
      { kind: "time", label: "Next", at: "2026-09-30T02:00:00.000Z", direction: "future" },
      { kind: "time", label: "Last fired", at: "2026-09-29T02:00:00.000Z", direction: "past" },
    ]);
  });

  it("leaves out the next fire of a paused trigger, and of any trigger while the workflow is off", () => {
    const paused = buildCard("nightly", {
      ...READS,
      triggers: [{ ...NIGHTLY, status: "paused" }],
    });
    assert.deepStrictEqual(Object.keys(listFacts(paused)), ["Fires on", "Status", "Last fired"]);
    assert.strictEqual(listFacts(paused).Status, "Paused");
    const off = buildCard("nightly", { ...READS, isWorkflowEnabled: false });
    assert.deepStrictEqual(Object.keys(listFacts(off)), ["Fires on", "Last fired"]);
  });

  it("shows an event trigger's kind in words and its filter as code", () => {
    assert.deepStrictEqual(buildCard("labeled").facts, [
      { kind: "text", label: "Fires on", value: "github.issue.labeled", isCode: false },
      { kind: "text", label: "Filter", value: 'event.payload.label == "ship"', isCode: true },
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
});
