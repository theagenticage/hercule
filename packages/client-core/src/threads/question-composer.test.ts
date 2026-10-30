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
  buildApprovalCard,
  buildQuestionDraft,
  buildQuestionStepper,
  describeFoldedQuestion,
  findComposerQuestion,
  pickQuestionOption,
  decideQuestionStep,
  typeQuestionAnswer,
  typeAnswerInRequestDraft,
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

    expect(found).toMatchObject({ requestId: "req-1", questions: QUESTIONS, question: FEATURES });
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

  it("keeps the question once its answers are sent, locked", () => {
    const found = findComposerQuestion(REQUEST, buildDraft({ answered: true }));

    expect(found?.question).toEqual(STORAGE);
    expect(found?.locked).toBe(true);
  });

  it("carries the answer's key, its typed text, the lock, the failure and the stepper", () => {
    const untouched = findComposerQuestion(REQUEST, buildDraft())!;
    const typed = findComposerQuestion(
      REQUEST,
      buildDraft({
        question: buildTypedDraft(QUESTIONS, { Features: "mine" }),
        shownQuestionIndex: 2,
        failure: "The controller refused.",
      }),
    )!;

    expect(untouched).toMatchObject({
      answerKey: "req-1:Storage",
      text: "",
      locked: false,
      failure: null,
    });
    expect(untouched.stepper).toEqual(buildQuestionStepper(buildDraft(), QUESTIONS));
    expect(typed).toMatchObject({
      answerKey: "req-1:Features",
      text: "mine",
      failure: "The controller refused.",
    });
    expect(typed.stepper).toMatchObject({ ready: true, stepLabel: NEXT_QUESTION_LABEL });
  });
});

describe("typeAnswerInRequestDraft", () => {
  it("types into a draft the user has not touched, leaving the other answers alone", () => {
    const draft = buildDraft({ shownQuestionIndex: 3, unfolded: true });

    const typed = typeAnswerInRequestDraft(draft, QUESTIONS, QUESTIONS[3]!, "no");

    expect(typed).toEqual({
      ...draft,
      question: { ...buildQuestionDraft(QUESTIONS), Notes: { picks: [], text: "no" } },
    });
    expect(draft.question).toBeNull();
  });

  it("types into the question it is given, not the one the draft shows", () => {
    const draft = buildDraft({ shownQuestionIndex: 3, unfolded: true });

    const typed = typeAnswerInRequestDraft(draft, QUESTIONS, STORAGE, "late edit");

    expect(typed.shownQuestionIndex).toBe(3);
    expect(typed.question).toEqual({
      ...buildQuestionDraft(QUESTIONS),
      Storage: { picks: [], text: "late edit" },
    });
  });

  it("replaces a pick on a single-select question and keeps the picks of a multiSelect one", () => {
    const picked = pickQuestionOption(buildQuestionDraft(QUESTIONS), STORAGE, "IndexedDB", "");
    const withFeature = pickQuestionOption(picked.question, FEATURES, "Sync", "");

    const first = typeAnswerInRequestDraft(
      buildDraft({ question: withFeature.question }),
      QUESTIONS,
      STORAGE,
      "mine",
    );
    const third = typeAnswerInRequestDraft(
      buildDraft({ question: withFeature.question, shownQuestionIndex: 2 }),
      QUESTIONS,
      FEATURES,
      "more",
    );

    expect(first.question!.Storage).toEqual({ picks: [], text: "mine" });
    expect(first.question!.Features).toEqual({ picks: ["Sync"], text: "" });
    expect(third.question!.Features).toEqual({ picks: ["Sync"], text: "more" });
  });
});

describe("the step controls", () => {
  it("labels the step Next until the last question, then Send answers, and shows Previous from the second", () => {
    const steppers = QUESTIONS.map((_, index) =>
      buildQuestionStepper(buildDraft({ shownQuestionIndex: index }), QUESTIONS),
    );

    expect(steppers.map((stepper) => stepper.stepLabel)).toEqual([
      "Next",
      "Next",
      "Next",
      "Send answers",
    ]);
    expect(steppers.map((stepper) => stepper.showsPrevious)).toEqual([false, true, true, true]);
  });

  it("invites the user to type their own answer beside options, and just to type when there are none", () => {
    expect(buildQuestionStepper(buildDraft(), QUESTIONS).placeholder).toBe(
      "Or type your own answer",
    );
    expect(buildQuestionStepper(buildDraft({ shownQuestionIndex: 3 }), QUESTIONS).placeholder).toBe(
      "Type your answer",
    );
  });

  const PICKED = pickQuestionOption(buildQuestionDraft(QUESTIONS), STORAGE, "IndexedDB", "");
  /** Builds a draft that shows question `at`, after the user typed `texts` (by header). */
  const typed = (
    texts: Readonly<Record<string, string>>,
    at = 0,
    extra: Partial<RequestDraft> = {},
  ) =>
    buildDraft({ question: buildTypedDraft(QUESTIONS, texts), shownQuestionIndex: at, ...extra });
  const BIG = (length: number) => "a".repeat(length);
  const OVER = "This answer is longer than 4,096 characters.";
  const SHOW_1 = { kind: "show", index: 1 };
  const SHOW_2 = { kind: "show", index: 2 };
  const SEND = { kind: "send", answers: { Storage: "x", Token: "x", Features: ["x"], Notes: "x" } };

  // One row per situation: the stepper's `ready` and `notice`, then what "next" and "previous"
  // do. Previous works exactly when its result is not null, so `canGoBack` is checked against it.
  const cases: readonly (readonly [
    string,
    RequestDraft,
    boolean,
    string | null,
    unknown,
    unknown,
  ])[] = [
    ["untouched, first question", buildDraft(), false, null, null, null],
    ["blank text, first question", typed({ Storage: "  \n " }), false, null, null, null],
    ["typed text, first question", typed({ Storage: " mine " }), true, null, SHOW_1, null],
    ["a pick, first question", buildDraft({ question: PICKED.question }), true, null, SHOW_1, null],
    ["blank middle question", buildDraft({ shownQuestionIndex: 2 }), false, null, null, SHOW_1],
    [
      "last question, an earlier one unanswered",
      typed({ Notes: "x" }, 3),
      false,
      null,
      null,
      SHOW_2,
    ],
    [
      "last question, blank after the others",
      buildDraft({
        question: { ...ALL_ANSWERED, Notes: { picks: [], text: " \n" } },
        shownQuestionIndex: 3,
      }),
      false,
      null,
      null,
      SHOW_2,
    ],
    [
      "last question, all answered",
      buildDraft({ question: ALL_ANSWERED, shownQuestionIndex: 3 }),
      true,
      null,
      SEND,
      SHOW_2,
    ],
    [
      "answers already sent",
      buildDraft({ question: ALL_ANSWERED, shownQuestionIndex: 3, answered: true }),
      false,
      null,
      null,
      null,
    ],
    ["answer of 4,096 characters", typed({ Storage: BIG(4096) }), true, null, SHOW_1, null],
    [
      "4,096 characters and spaces",
      typed({ Storage: `  ${BIG(4096)}\n\n` }),
      true,
      null,
      SHOW_1,
      null,
    ],
    ["answer of 4,097 characters", typed({ Storage: BIG(4097) }), false, OVER, null, null],
    ["4,097 typed on a multiSelect", typed({ Features: BIG(4097) }, 2), false, OVER, null, SHOW_1],
  ];

  it.each(cases)("%s", (_name, draft, ready, notice, next, previous) => {
    expect(buildQuestionStepper(draft, QUESTIONS)).toMatchObject({
      ready,
      notice,
      canGoBack: previous !== null,
    });
    expect(decideQuestionStep(draft, QUESTIONS, "next")).toEqual(next);
    expect(decideQuestionStep(draft, QUESTIONS, "previous")).toEqual(previous);
  });

  it("sends the answers as buildQuestionAnswers serializes them: picks, then trimmed text", () => {
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

    expect(
      decideQuestionStep(
        buildDraft({ question: questionDraft, shownQuestionIndex: 3 }),
        QUESTIONS,
        "next",
      ),
    ).toEqual({
      kind: "send",
      answers: {
        Storage: "IndexedDB",
        Token: "hunter2",
        Features: ["Search", "and more"],
        Notes: "no",
      },
    });
  });

  it("counts headers and every answer toward the 16,384 characters of all answers, even while a question is unanswered", () => {
    const LIMIT = 4096;
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
    // The last answer is still unanswered, but the others already leave no room for it.
    const room = buildTypedDraft(FOUR, {
      A: "a".repeat(LIMIT),
      B: "a".repeat(LIMIT),
      C: "a".repeat(LIMIT),
    });
    // The user may be on the first question while the last is already typed.
    const stepperAt = (question: QuestionDraft, shownQuestionIndex: number) =>
      buildQuestionStepper(buildDraft({ question, shownQuestionIndex }), FOUR);

    expect(stepperAt(atLimit, 3)).toMatchObject({ ready: true, notice: null });
    expect(stepperAt(atLimit, 0)).toMatchObject({ ready: true, notice: null });
    expect(stepperAt(over, 3)).toMatchObject({
      ready: false,
      notice: "These answers are longer than 16,384 characters together.",
    });
    expect(stepperAt(over, 0).ready).toBe(false);
    expect(stepperAt(room, 0).notice).toBeNull();
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
