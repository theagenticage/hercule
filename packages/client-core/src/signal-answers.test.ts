/**
 * Tests a signal's answers: their order, their style, the workflow a Hand to
 * an agent answer starts, the suggested answer, and a label's ellipsis.
 */
import type { Signal, SignalAction } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildSignalAnswers, findSuggestedAnswer, trimAnswerEllipsis } from "./signal-answers";

const EVENT_ORIGIN = {
  type: "event",
  eventId: 1,
  connectionId: "01a06d02-7200-7000-8000-000000000001",
  threadRef: "acme/webshop#1296",
} as const;

/** Builds an open signal of `kind`, created at `createdAt`, with the given fields changed. */
const buildSignal = (id: string, overrides: Partial<Signal> = {}): Signal => ({
  id,
  kind: "github/mentioned",
  origin: EVENT_ORIGIN,
  title: `Signal ${id}`,
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: "2026-10-10T09:00:00.000Z",
  ...overrides,
});

const action = (id: string, overrides: Partial<SignalAction> = {}): SignalAction => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
  operation: { op: "github/pr.review", input: {} },
  ...overrides,
});

describe("buildSignalAnswers", () => {
  const signal = buildSignal("a", {
    actions: [
      action("done", { label: "Done", operation: null }),
      action("hand-to-bugfix", {
        label: "Hand to Bugfix",
        operation: { op: "run.start", input: {} },
      }),
      action("rerun", { label: "Run again", operation: { op: "run.start", input: {} } }),
      action("approve", { primary: true }),
      action("reply", { label: "Reply…", field: { name: "body", placeholder: "Write a reply" } }),
      action("dismiss", { label: "Dismiss", operation: null }),
    ],
  });
  const answers = buildSignalAnswers(signal);

  it("orders the actions the plugin gave, then Hand to an agent, then Done", () => {
    // `rerun` binds run.start too, but the raiser gave it, so it keeps its place.
    expect(answers.map((answer) => answer.action.id)).toEqual([
      "rerun",
      "approve",
      "reply",
      "dismiss",
      "hand-to-bugfix",
      "done",
    ]);
  });

  it("styles each answer by what it does", () => {
    expect(answers.map((answer) => answer.style)).toEqual([
      "plain",
      "plain",
      "reply",
      "quiet",
      "plain",
      "done",
    ]);
  });

  // Signals written before `signal.handOff` existed keep their `run.start` answers.
  it.each([
    ["signal.handOff", (workflowId: string) => ({ signalId: "b", workflowId })],
    ["run.start", (workflowId: string) => ({ workflowId, inputs: { signal: "b" } })],
  ] as const)(
    "gives a Hand to an agent answer that binds %s the workflow it starts, and no other answer one",
    (op, buildInput) => {
      const workflowId = "01a0ec64-6e80-7000-8000-0000000000f8";
      const [handOff] = buildSignalAnswers(
        buildSignal("b", {
          actions: [
            action(`hand-to-${workflowId}`, {
              operation: { op, input: buildInput(workflowId) },
            }),
          ],
        }),
      );
      expect(handOff?.workflowId).toBe(workflowId);
      expect(answers.every((answer) => answer.workflowId === null)).toBe(true);
    },
  );

  it("finds the primary action as the suggested answer", () => {
    expect(findSuggestedAnswer(answers)?.action.id).toBe("approve");
    expect(findSuggestedAnswer(buildSignalAnswers(buildSignal("b")))).toBeUndefined();
  });

  it("drops only an ellipsis at the end of a label", () => {
    expect(trimAnswerEllipsis("Reply…")).toBe("Reply");
    expect(trimAnswerEllipsis("Approve")).toBe("Approve");
    expect(trimAnswerEllipsis("Wait… then go")).toBe("Wait… then go");
  });
});
