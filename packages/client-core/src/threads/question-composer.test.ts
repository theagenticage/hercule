/**
 * Tests answering a `question` Request in the composer: when the composer
 * answers, what the step button and Previous do, and the words and length
 * limits around them. Both apps draw from these, so the tests drive them the
 * way an app does: a Request, a `RequestDraft`, and the questions of
 * `buildApprovalCard`.
 */
import { describe, expect, it } from "vitest";
import type { SessionRequest } from "@hercule/contract";
import {
  EMPTY_REQUEST_DRAFT,
  NEXT_QUESTION_LABEL,
  SEND_ANSWERS_LABEL,
  buildApprovalCard,
  buildQuestionAnswers,
  buildQuestionDraft,
  buildQuestionStepper,
  describeFoldedQuestion,
  findComposerQuestion,
  pickQuestionOption,
  stepQuestions,
  typeQuestionAnswer,
  type ApprovalQuestion,
  type QuestionDraft,
  type RequestDraft,
} from "@hercule/client-core";

type QuestionRequest = Extract<SessionRequest, { readonly kind: "question" }>;

const buildQuestionRequest = (
  questions: QuestionRequest["detail"]["questions"],
  extra: { readonly async?: true } = {},
): QuestionRequest => ({
  requestId: "req-1",
  itemId: "tool-1",
  kind: "question",
  detail: { questions },
  ...extra,
});

/** Four questions: a secret one sits in the middle, and the last takes free text only. */
const REQUEST = buildQuestionRequest([
  {
    question: "Which storage should drafts use?",
    header: "Storage",
    options: [{ label: "localStorage" }, { label: "IndexedDB" }],
    multiSelect: false,
  },
  {
    question: "What is the token?",
    header: "Token",
    options: [],
    multiSelect: false,
    secret: true,
  },
  {
    question: "Which features should ship?",
    header: "Features",
    options: [{ label: "Sync" }, { label: "Search" }],
    multiSelect: true,
  },
  { question: "Anything else?", header: "Notes", options: [], multiSelect: false },
]);
const QUESTIONS = buildApprovalCard(REQUEST).questions;
const STORAGE = QUESTIONS[0]!;
const FEATURES = QUESTIONS[2]!;

const buildDraft = (change: Partial<RequestDraft> = {}): RequestDraft => ({
  ...EMPTY_REQUEST_DRAFT,
  ...change,
});

/** Builds the draft of `questions` after the user typed `texts` (by header). */
const buildTypedDraft = (
  questions: readonly ApprovalQuestion[],
  texts: Readonly<Record<string, string>>,
): QuestionDraft =>
  questions.reduce(
    (draft, question) =>
      question.header in texts
        ? typeQuestionAnswer(draft, question, texts[question.header]!)
        : draft,
    buildQuestionDraft(questions),
  );

/** Builds the draft of a Request whose every question is answered with the text "x". */
const ALL_ANSWERED = buildTypedDraft(QUESTIONS, {
  Storage: "x",
  Token: "x",
  Features: "x",
  Notes: "x",
});

describe("findComposerQuestion", () => {
  it("stays a message composer without a Request, and on every Request that is not a question", () => {
    const approval: SessionRequest = {
      requestId: "req-2",
      itemId: "tool-2",
      kind: "command_approval",
      decisions: ["allow", "deny"],
      detail: { command: "ls" },
    };

    expect(findComposerQuestion(null, EMPTY_REQUEST_DRAFT)).toBeNull();
    expect(findComposerQuestion(approval, EMPTY_REQUEST_DRAFT)).toBeNull();
  });

  it("answers the shown question of a blocking question, without the user unfolding anything", () => {
    const found = findComposerQuestion(REQUEST, buildDraft({ shownQuestionIndex: 2 }));

    expect(found).toEqual({ requestId: "req-1", questions: QUESTIONS, question: FEATURES });
  });

  it("stays a message composer while the shown question is secret, and answers the others around it", () => {
    expect(findComposerQuestion(REQUEST, buildDraft({ shownQuestionIndex: 1 }))).toBeNull();
    expect(findComposerQuestion(REQUEST, buildDraft({ shownQuestionIndex: 0 }))?.question).toEqual(
      STORAGE,
    );
    expect(
      findComposerQuestion(REQUEST, buildDraft({ shownQuestionIndex: 3 }))?.question.header,
    ).toBe("Notes");
  });

  it("leaves an async question alone while it is folded, and answers it once it is unfolded", () => {
    const asyncRequest = buildQuestionRequest(REQUEST.detail.questions, { async: true });

    expect(findComposerQuestion(asyncRequest, buildDraft({ unfolded: false }))).toBeNull();
    expect(findComposerQuestion(asyncRequest, buildDraft({ unfolded: true }))?.question).toEqual(
      STORAGE,
    );
  });

  it("keeps the question once its answers are sent, so the composer stays locked on it", () => {
    expect(findComposerQuestion(REQUEST, buildDraft({ answered: true }))?.question).toEqual(
      STORAGE,
    );
  });
});

describe("buildQuestionStepper", () => {
  it("labels the step Next until the last question, then Send answers", () => {
    const labels = QUESTIONS.map(
      (_, index) =>
        buildQuestionStepper(buildDraft({ shownQuestionIndex: index }), QUESTIONS).stepLabel,
    );

    expect(labels).toEqual([
      NEXT_QUESTION_LABEL,
      NEXT_QUESTION_LABEL,
      NEXT_QUESTION_LABEL,
      SEND_ANSWERS_LABEL,
    ]);
    expect(labels[0]).toBe("Next");
    expect(labels[3]).toBe("Send answers");
  });

  it("shows Previous from the second question on", () => {
    const first = buildQuestionStepper(buildDraft(), QUESTIONS);
    const second = buildQuestionStepper(buildDraft({ shownQuestionIndex: 1 }), QUESTIONS);

    expect([first.showsPrevious, first.canGoBack]).toEqual([false, false]);
    expect([second.showsPrevious, second.canGoBack]).toEqual([true, true]);
  });

  it("invites the user to type their own answer beside options, and just to type when there are none", () => {
    const withOptions = buildQuestionStepper(buildDraft(), QUESTIONS);
    const without = buildQuestionStepper(buildDraft({ shownQuestionIndex: 3 }), QUESTIONS);

    expect(withOptions.placeholder).toBe("Or type your own answer");
    expect(without.placeholder).toBe("Type your answer");
  });

  it("is not ready for a user who touched nothing, as if every question were blank", () => {
    const stepper = buildQuestionStepper(buildDraft({ question: null }), QUESTIONS);

    expect(stepper.ready).toBe(false);
    expect(stepper.notice).toBeNull();
  });

  it("is ready once the shown question has a pick or typed text, not blank text", () => {
    const picked = pickQuestionOption(buildQuestionDraft(QUESTIONS), STORAGE, "IndexedDB", "");
    const blank = buildTypedDraft(QUESTIONS, { Storage: "  \n " });
    const typed = buildTypedDraft(QUESTIONS, { Storage: " mine " });

    expect(buildQuestionStepper(buildDraft({ question: picked.question }), QUESTIONS).ready).toBe(
      true,
    );
    expect(buildQuestionStepper(buildDraft({ question: blank }), QUESTIONS).ready).toBe(false);
    expect(buildQuestionStepper(buildDraft({ question: typed }), QUESTIONS).ready).toBe(true);
  });

  it("asks for every question to be answered before it sends from the last one", () => {
    const lastOnly = buildTypedDraft(QUESTIONS, { Notes: "x" });

    const stepper = buildQuestionStepper(
      buildDraft({ question: lastOnly, shownQuestionIndex: 3 }),
      QUESTIONS,
    );

    expect(stepper.ready).toBe(false);
    expect(stepper.notice).toBeNull();
  });

  it("locks everything once the answers are sent, but still shows Previous", () => {
    const stepper = buildQuestionStepper(
      buildDraft({ question: ALL_ANSWERED, shownQuestionIndex: 3, answered: true }),
      QUESTIONS,
    );

    expect(stepper.ready).toBe(false);
    expect(stepper.canGoBack).toBe(false);
    expect(stepper.showsPrevious).toBe(true);
  });

  describe("the length limits", () => {
    const LIMIT = 4096;

    it("accepts an answer of exactly 4,096 characters and refuses one more, with a notice", () => {
      const atLimit = buildDraft({
        question: buildTypedDraft(QUESTIONS, { Storage: "a".repeat(LIMIT) }),
      });
      const over = buildDraft({
        question: buildTypedDraft(QUESTIONS, { Storage: "a".repeat(LIMIT + 1) }),
      });

      expect(buildQuestionStepper(atLimit, QUESTIONS)).toMatchObject({ ready: true, notice: null });
      expect(buildQuestionStepper(over, QUESTIONS)).toMatchObject({
        ready: false,
        notice: "This answer is longer than 4,096 characters.",
      });
    });

    it("counts the trimmed text, so spaces around an answer at the limit do not push it over", () => {
      const padded = buildDraft({
        question: buildTypedDraft(QUESTIONS, { Storage: `  ${"a".repeat(LIMIT)}\n\n` }),
      });

      expect(buildQuestionStepper(padded, QUESTIONS).ready).toBe(true);
    });

    it("applies the answer limit to the typed text of a multiSelect question too", () => {
      const over = buildDraft({
        question: buildTypedDraft(QUESTIONS, { Features: "a".repeat(LIMIT + 1) }),
        shownQuestionIndex: 2,
      });

      expect(buildQuestionStepper(over, QUESTIONS).notice).toBe(
        "This answer is longer than 4,096 characters.",
      );
    });

    // Four one-letter headers, so the headers add 4 characters to the total.
    const buildFreeTextQuestion = (header: string) => ({
      question: header,
      header,
      options: [],
      multiSelect: false,
    });
    const FOUR = buildApprovalCard(
      buildQuestionRequest([
        buildFreeTextQuestion("A"),
        buildFreeTextQuestion("B"),
        buildFreeTextQuestion("C"),
        buildFreeTextQuestion("D"),
      ]),
    ).questions;

    it("counts headers and every answer toward the 16,384 characters of all answers, even while a question is unanswered", () => {
      // 4 headers + 3 * 4,096 + 4,092 = 16,384 exactly.
      const atLimit = buildTypedDraft(FOUR, {
        A: "a".repeat(LIMIT),
        B: "a".repeat(LIMIT),
        C: "a".repeat(LIMIT),
        D: "a".repeat(LIMIT - 4),
      });
      const over = buildTypedDraft(FOUR, {
        A: "a".repeat(LIMIT),
        B: "a".repeat(LIMIT),
        C: "a".repeat(LIMIT),
        D: "a".repeat(LIMIT - 3),
      });
      // The user went back to the first question; the last is already typed.
      const stepperAt = (question: QuestionDraft, shownQuestionIndex: number) =>
        buildQuestionStepper(buildDraft({ question, shownQuestionIndex }), FOUR);

      expect(stepperAt(atLimit, 3)).toMatchObject({ ready: true, notice: null });
      expect(stepperAt(atLimit, 0)).toMatchObject({ ready: true, notice: null });
      expect(stepperAt(over, 3)).toMatchObject({
        ready: false,
        notice: "These answers are longer than 16,384 characters together.",
      });
      expect(stepperAt(over, 0).ready).toBe(false);
      // The last answer is still unanswered, but the others already leave no room for it.
      const room = buildTypedDraft(FOUR, {
        A: "a".repeat(LIMIT),
        B: "a".repeat(LIMIT),
        C: "a".repeat(LIMIT),
      });
      expect(stepperAt(room, 0).notice).toBeNull();
    });
  });
});

describe("stepQuestions", () => {
  it("has no question before the first", () => {
    expect(stepQuestions(buildDraft(), QUESTIONS, "previous")).toBeNull();
  });

  it("goes back one question, even from a blank answer", () => {
    const draft = buildDraft({ shownQuestionIndex: 2 });

    expect(stepQuestions(draft, QUESTIONS, "previous")).toEqual({ kind: "show", index: 1 });
  });

  it("goes back from an over-long answer", () => {
    const draft = buildDraft({
      question: buildTypedDraft(QUESTIONS, { Features: "a".repeat(5000) }),
      shownQuestionIndex: 2,
    });

    expect(buildQuestionStepper(draft, QUESTIONS).ready).toBe(false);
    expect(stepQuestions(draft, QUESTIONS, "previous")).toEqual({ kind: "show", index: 1 });
  });

  it("goes nowhere once the answers are sent", () => {
    const draft = buildDraft({ question: ALL_ANSWERED, shownQuestionIndex: 3, answered: true });

    expect(stepQuestions(draft, QUESTIONS, "previous")).toBeNull();
    expect(stepQuestions(draft, QUESTIONS, "next")).toBeNull();
  });

  it("does not go on from an unanswered question", () => {
    expect(stepQuestions(buildDraft(), QUESTIONS, "next")).toBeNull();
  });

  it("goes on to the next question, secret or not, once the shown one is answered", () => {
    const draft = buildDraft({ question: buildTypedDraft(QUESTIONS, { Storage: "mine" }) });

    expect(stepQuestions(draft, QUESTIONS, "next")).toEqual({ kind: "show", index: 1 });
  });

  it("sends from the last question the answers buildQuestionAnswers builds", () => {
    let questionDraft = pickQuestionOption(
      buildQuestionDraft(QUESTIONS),
      STORAGE,
      "IndexedDB",
      "",
    ).question;
    questionDraft = typeQuestionAnswer(questionDraft, QUESTIONS[1]!, "  hunter2 ");
    questionDraft = pickQuestionOption(questionDraft, FEATURES, "Search", "").question;
    questionDraft = typeQuestionAnswer(questionDraft, FEATURES, " and more ");
    questionDraft = typeQuestionAnswer(questionDraft, QUESTIONS[3]!, "no");
    const draft = buildDraft({ question: questionDraft, shownQuestionIndex: 3 });

    expect(stepQuestions(draft, QUESTIONS, "next")).toEqual({
      kind: "send",
      answers: buildQuestionAnswers(questionDraft, QUESTIONS),
    });
    expect(buildQuestionAnswers(questionDraft, QUESTIONS)).toEqual({
      Storage: "IndexedDB",
      Token: "hunter2",
      Features: ["Search", "and more"],
      Notes: "no",
    });
  });

  it("does not send while an earlier question is unanswered", () => {
    const draft = buildDraft({
      question: buildTypedDraft(QUESTIONS, { Notes: "x" }),
      shownQuestionIndex: 3,
    });

    expect(stepQuestions(draft, QUESTIONS, "next")).toBeNull();
  });

  it("does not go on from an answer over the limit, and goes on at the limit", () => {
    const at = buildDraft({ question: buildTypedDraft(QUESTIONS, { Storage: "a".repeat(4096) }) });
    const over = buildDraft({
      question: buildTypedDraft(QUESTIONS, { Storage: "a".repeat(4097) }),
    });

    expect(stepQuestions(at, QUESTIONS, "next")).toEqual({ kind: "show", index: 1 });
    expect(stepQuestions(over, QUESTIONS, "next")).toBeNull();
  });

  it("never disagrees with the stepper about whether the step button works", () => {
    const drafts: RequestDraft[] = [
      buildDraft(),
      buildDraft({ question: buildTypedDraft(QUESTIONS, { Storage: "x" }) }),
      buildDraft({ question: buildTypedDraft(QUESTIONS, { Storage: "a".repeat(4097) }) }),
      buildDraft({ question: ALL_ANSWERED, shownQuestionIndex: 3 }),
      buildDraft({ question: ALL_ANSWERED, shownQuestionIndex: 3, answered: true }),
      buildDraft({ question: buildTypedDraft(QUESTIONS, { Notes: "x" }), shownQuestionIndex: 3 }),
      buildDraft({
        question: { ...ALL_ANSWERED, Notes: { picks: [], text: " \n" } },
        shownQuestionIndex: 3,
      }),
    ];

    for (const draft of drafts) {
      expect(stepQuestions(draft, QUESTIONS, "next") !== null).toBe(
        buildQuestionStepper(draft, QUESTIONS).ready,
      );
    }
  });
});

describe("describeFoldedQuestion", () => {
  it("says the agent asked a question and keeps working", () => {
    const one = buildQuestionRequest([REQUEST.detail.questions[0]], { async: true });

    expect(describeFoldedQuestion(one)).toBe("The agent asked a question. It keeps working.");
  });

  it("counts the questions when there are several", () => {
    const two = buildQuestionRequest([REQUEST.detail.questions[0], REQUEST.detail.questions[1]!], {
      async: true,
    });

    expect(describeFoldedQuestion(two)).toBe("The agent asked 2 questions. It keeps working.");
  });
});
