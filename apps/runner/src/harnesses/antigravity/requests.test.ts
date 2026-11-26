/**
 * Tests the translation between Hercule's decisions and answers and the ACP
 * replies `agy` expects. The form and the options are the ones recorded from
 * agy 1.5.15; the other forms are small and made by hand.
 */
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import type { ElicitationField, ElicitationRequest } from "@hercule/acp";
import { MAX_FACT_ITEMS, MAX_FACT_LENGTH, type QuestionAnswers } from "@hercule/protocol";
import {
  buildApprovalOutcome,
  buildElicitationReply,
  readApprovalDecisions,
  type QuestionForm,
  readQuestionForm,
} from "./requests";

const RECORDED_OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

describe("approvals", () => {
  it("offers allow, deny and cancel when the request has an allow_once option", () => {
    expect(readApprovalDecisions(RECORDED_OPTIONS)).toEqual(["allow", "deny", "cancel"]);
  });

  it("offers no allow, and never allow_always, without an allow_once option", () => {
    const options = [{ optionId: "always", name: "Always", kind: "allow_always" }];
    expect(readApprovalDecisions(options)).toEqual(["deny", "cancel"]);
    expect(readApprovalDecisions(RECORDED_OPTIONS)).not.toContain("allow_always");
  });

  it("selects options by kind, the first of that kind, whatever their id or label", () => {
    const options = [
      { optionId: "deny", name: "Allow", kind: "allow_always" },
      { optionId: "first-allow", name: "Deny", kind: "allow_once" },
      { optionId: "second-allow", name: "Allow", kind: "allow_once" },
      { optionId: "allow", name: "No", kind: "reject_once" },
    ];
    expect(buildApprovalOutcome(options, "allow")).toEqual({
      outcome: "selected",
      optionId: "first-allow",
    });
    expect(buildApprovalOutcome(options, "deny")).toEqual({
      outcome: "selected",
      optionId: "allow",
    });
  });

  it("answers deny with cancelled when the request has no reject_once option", () => {
    const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }];
    expect(buildApprovalOutcome(options, "deny")).toEqual({ outcome: "cancelled" });
  });

  it("answers cancel with cancelled even when options exist", () => {
    expect(buildApprovalOutcome(RECORDED_OPTIONS, "cancel")).toEqual({ outcome: "cancelled" });
  });
});

/** Returns a form request holding `properties`. */
const buildRequest = (
  properties: Record<string, ElicitationField>,
  required?: ReadonlyArray<string>,
): ElicitationRequest => ({
  requestId: "req-1",
  message: "The agent has a question.",
  requestedSchema: { properties, ...(required === undefined ? {} : { required }) },
  raw: {},
  replyWritten: Effect.void,
});

/** Returns a single-select field with a choice per title, with consts "1", "2", ... */
const buildSelect = (title: string, ...titles: ReadonlyArray<string>): ElicitationField => ({
  type: "string",
  title,
  oneOf: titles.map((choiceTitle, index) => ({ const: String(index + 1), title: choiceTitle })),
});

const OTHER: ElicitationField = { type: "string", title: "Other" };

/** Returns the reply for answers that must be accepted. */
const answerOk = (form: QuestionForm, answers: QuestionAnswers) => {
  const result = buildElicitationReply(form, answers);
  if (result.kind === "refused") throw new Error(`expected a reply, refused: ${result.message}`);
  return result.reply;
};

/** Reads a form that must be readable. */
const readForm = (
  properties: Record<string, ElicitationField>,
  required?: ReadonlyArray<string>,
) => {
  const form = readQuestionForm(buildRequest(properties, required));
  if (form === undefined) throw new Error("expected a readable form");
  return form;
};

describe("a recorded single-choice question", () => {
  const properties = {
    q1: buildSelect("Which colour should the banner be?", "Red", "Green", "Blue"),
    q1_other: {
      type: "string",
      title: "Other",
      description: "Optional free-form answer to: Which colour should the banner be?",
    },
  };

  it("becomes one question whose options are the titles, without descriptions", () => {
    expect(readForm(properties).questions).toEqual([
      {
        question: "Which colour should the banner be?",
        header: "Question",
        options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }],
        multiSelect: false,
      },
    ]);
  });

  it("answers a chosen option with its const alone", () => {
    expect(answerOk(readForm(properties), { Question: "Green" })).toEqual({
      action: "accept",
      content: { q1: "2" },
    });
  });

  it("answers typed text in q1_other alone", () => {
    expect(answerOk(readForm(properties), { Question: "Purple" })).toEqual({
      action: "accept",
      content: { q1_other: "Purple" },
    });
  });

  it("refuses typed text, telling the user to pick, when there is no q1_other to carry it", () => {
    const form = readForm({ q1: properties.q1 });
    expect(buildElicitationReply(form, { Question: "Purple" })).toEqual({
      kind: "refused",
      message: "Question takes one of its options only. Pick one of them.",
    });
  });

  it("refuses a list of several answers and accepts a list of one", () => {
    const form = readForm(properties);
    expect(buildElicitationReply(form, { Question: ["Red", "Blue"] }).kind).toBe("refused");
    expect(answerOk(form, { Question: ["Red"] })).toEqual({
      action: "accept",
      content: { q1: "1" },
    });
  });
});

describe("several questions", () => {
  const form = readForm({
    q1: buildSelect("First?", "A", "B"),
    q2: buildSelect("Second?", "C", "D"),
    q2_other: OTHER,
  });

  it("numbers the headers in order", () => {
    expect(form.questions.map((question) => question.header)).toEqual(["Question 1", "Question 2"]);
  });

  it("answers each question in its own field, an option for one and text for another", () => {
    expect(answerOk(form, { "Question 1": "B", "Question 2": "something else" })).toEqual({
      action: "accept",
      content: { q1: "2", q2_other: "something else" },
    });
  });

  it("leaves out an unanswered question that is not required", () => {
    expect(answerOk(form, { "Question 2": "C" })).toEqual({
      action: "accept",
      content: { q2: "1" },
    });
  });

  it("refuses an unanswered question the form requires", () => {
    const required = readForm({ q1: buildSelect("First?", "A"), q2: buildSelect("Second?", "C") }, [
      "q2",
    ]);
    expect(buildElicitationReply(required, { "Question 1": "A" })).toEqual({
      kind: "refused",
      message: "Question 2 needs an answer. Answer it.",
    });
  });

  it("refuses an answer under a header the form does not have", () => {
    expect(buildElicitationReply(form, { "Question 1": "A", "Question 9": "B" }).kind).toBe(
      "refused",
    );
  });
});

describe("option labels that are equal", () => {
  it("keeps the first of equal labels, also after truncation, and maps it to its own const", () => {
    const long = "x".repeat(MAX_FACT_LENGTH + 10);
    const form = readForm({ q1: buildSelect("Pick?", "Red", long, "Blue", "Red", `${long}b`) });
    const labels = form.questions[0].options.map((option) => option.label);
    expect(labels).toHaveLength(3);
    expect([labels[0], labels[2]]).toEqual(["Red", "Blue"]);
    const consts = labels.map((label) => {
      const reply = answerOk(form, { Question: label });
      return reply.action === "accept" ? reply.content["q1"] : undefined;
    });
    expect(consts).toEqual(["1", "2", "3"]);
  });
});

describe("a form too big for the protocol", () => {
  const choices = (count: number) =>
    Array.from({ length: count }, (_, index) => `Choice ${String(index)}`);

  it("reads a form at the bounds", () => {
    const properties = Object.fromEntries(
      Array.from({ length: MAX_FACT_ITEMS }, (_, index) => [
        `q${String(index)}`,
        buildSelect("Pick?", "A"),
      ]),
    );
    expect(readQuestionForm(buildRequest(properties))).toBeDefined();
    expect(
      readQuestionForm(buildRequest({ q1: buildSelect("Pick?", ...choices(MAX_FACT_ITEMS)) })),
    ).toBeDefined();
  });

  it("is undefined for too many questions", () => {
    const properties = Object.fromEntries(
      Array.from({ length: MAX_FACT_ITEMS + 1 }, (_, index) => [
        `q${String(index)}`,
        buildSelect("Pick?", "A"),
      ]),
    );
    expect(readQuestionForm(buildRequest(properties))).toBeUndefined();
  });

  it("is undefined for too many choices", () => {
    const properties = { q1: buildSelect("Pick?", ...choices(MAX_FACT_ITEMS + 1)) };
    expect(readQuestionForm(buildRequest(properties))).toBeUndefined();
  });

  it("is undefined when the text of all of it would not fit one frame", () => {
    const long = "y".repeat(MAX_FACT_LENGTH);
    const properties = Object.fromEntries(
      Array.from({ length: MAX_FACT_ITEMS }, (_, index) => [
        `q${String(index)}`,
        buildSelect(
          "Pick?",
          ...Array.from({ length: MAX_FACT_ITEMS }, (_, choice) => `${String(choice)}${long}`),
        ),
      ]),
    );
    expect(readQuestionForm(buildRequest(properties))).toBeUndefined();
  });
});

describe("a recorded form with a multi-select question", () => {
  // The form of agy 1.5.15 (question-variants, "The agent has 2 questions."),
  // field for field.
  const properties: Record<string, ElicitationField> = {
    q1: buildSelect("Which colour should the banner be?", "Red", "Green", "Blue"),
    q1_other: OTHER,
    q2: {
      type: "array",
      title: "Which features would you like to enable?",
      items: {
        anyOf: [
          { const: "1", title: "Dark mode" },
          { const: "2", title: "Search" },
          { const: "3", title: "Export" },
        ],
      },
    },
    q2_other: OTHER,
  };

  it("reads the array as a multi-select whose options are the anyOf titles", () => {
    expect(readForm(properties).questions).toEqual([
      {
        question: "Which colour should the banner be?",
        header: "Question 1",
        options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }],
        multiSelect: false,
      },
      {
        question: "Which features would you like to enable?",
        header: "Question 2",
        options: [{ label: "Dark mode" }, { label: "Search" }, { label: "Export" }],
        multiSelect: true,
      },
    ]);
  });

  it("answers labels with the array of their consts", () => {
    const form = readForm(properties);
    expect(
      answerOk(form, { "Question 1": "Green", "Question 2": ["Dark mode", "Export"] }),
    ).toEqual({ action: "accept", content: { q1: "2", q2: ["1", "3"] } });
  });

  it("answers typed text in q2_other alone, and a label plus typed text in both fields", () => {
    const form = readForm(properties);
    expect(answerOk(form, { "Question 2": ["Sound"] })).toEqual({
      action: "accept",
      content: { q2_other: "Sound" },
    });
    expect(answerOk(form, { "Question 2": ["Search", "Sound"] })).toEqual({
      action: "accept",
      content: { q2: ["2"], q2_other: "Sound" },
    });
  });

  it("refuses two typed texts, and still refuses several answers to a single-choice question", () => {
    const form = readForm(properties);
    expect(buildElicitationReply(form, { "Question 2": ["A", "B"] }).kind).toBe("refused");
    expect(buildElicitationReply(form, { "Question 1": ["Red", "Blue"] }).kind).toBe("refused");
  });

  it("refuses a typed answer when the multi-select has no q2_other", () => {
    const form = readForm({ q1: properties["q1"]!, q2: properties["q2"]! });
    expect(buildElicitationReply(form, { "Question 2": ["Sound"] }).kind).toBe("refused");
  });
});

describe("a form that cannot be read", () => {
  const cases: Record<string, Record<string, ElicitationField>> = {
    "a multi-select listing plain strings": {
      q1: { type: "array", title: "Pick?", items: { enum: ["a", "b"] } },
    },
    "a field of another type": { q1: { type: "boolean", title: "Sure?" } },
    "a field with no choices": { q1: { type: "string", title: "Name?" } },
    "a field with no title": {
      q1: { type: "string", oneOf: [{ const: "1", title: "A" }] },
    },
    "an unknown property": { q1: buildSelect("Pick?", "A"), extra: OTHER },
    "a question beside a bad one": {
      q1: buildSelect("Pick?", "A"),
      q2: { type: "array", title: "Many?" },
    },
    "no question at all": { q1_other: OTHER },
  };
  for (const [name, properties] of Object.entries(cases)) {
    it(`is undefined for ${name}`, () => {
      expect(readQuestionForm(buildRequest(properties))).toBeUndefined();
    });
  }
});
