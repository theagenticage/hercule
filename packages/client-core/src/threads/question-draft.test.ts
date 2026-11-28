/**
 * Tests the question draft: what the user has picked and typed for each
 * question of a `question` request, before the answers are sent. Both docks
 * hold a draft in state and build the `answers` record of `session.respondToQuestion`
 * from it, so the two apps agree on what an answer is.
 *
 * The questions come from `buildApprovalCard`, as the docks get them.
 */
import { describe, expect, it } from "vitest";
import type { OpenRequest } from "@hercule/contract";
import {
  buildApprovalCard,
  buildQuestionAnswers,
  buildQuestionDraft,
  isQuestionAnswered,
  pickQuestionOption,
  typeQuestionAnswer,
  type ApprovalQuestion,
  type QuestionDraft,
} from "@hercule/client-core";

const REQUEST: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "question",
  detail: {
    questions: [
      {
        question: "Which storage should drafts use?",
        header: "Storage",
        options: [
          { label: "localStorage", description: "small and synchronous" },
          { label: "IndexedDB", description: "large and asynchronous" },
        ],
        multiSelect: false,
      },
      {
        question: "Which features should ship?",
        header: "Features",
        options: [
          { label: "Sync", description: "" },
          { label: "Search", description: "" },
          { label: "Export", description: "" },
        ],
        multiSelect: true,
      },
    ],
  },
};

const QUESTIONS = buildApprovalCard(REQUEST).questions;
const STORAGE = QUESTIONS[0]!;
const FEATURES = QUESTIONS[1]!;

/** Picks an option when the user has no message text to move. */
const pick = (draft: QuestionDraft, question: ApprovalQuestion, label: string): QuestionDraft =>
  pickQuestionOption(draft, question, label, "").question;

describe("the question draft", () => {
  it("starts with no question answered and no answers", () => {
    const draft = buildQuestionDraft(QUESTIONS);

    expect(isQuestionAnswered(draft, STORAGE)).toBe(false);
    expect(isQuestionAnswered(draft, FEATURES)).toBe(false);
    expect(buildQuestionAnswers(draft, QUESTIONS)).toBeNull();
  });

  it("selects only the picked option on a single-select question, and clears the typed text", () => {
    let draft = buildQuestionDraft(QUESTIONS);
    draft = typeQuestionAnswer(draft, STORAGE, "a sqlite file");
    draft = pick(draft, STORAGE, "localStorage");
    draft = pick(draft, STORAGE, "IndexedDB");

    expect(draft[STORAGE.header]).toEqual({ picks: ["IndexedDB"], text: "" });
  });

  it("clears the pick when the user types on a single-select question", () => {
    let draft = buildQuestionDraft(QUESTIONS);
    draft = pick(draft, STORAGE, "localStorage");
    draft = typeQuestionAnswer(draft, STORAGE, "a sqlite file");

    expect(draft[STORAGE.header]).toEqual({ picks: [], text: "a sqlite file" });
  });

  it("toggles a picked option on a multiSelect question, and keeps the typed text", () => {
    let draft = buildQuestionDraft(QUESTIONS);
    draft = typeQuestionAnswer(draft, FEATURES, "Offline mode");
    draft = pick(draft, FEATURES, "Sync");
    draft = pick(draft, FEATURES, "Search");
    draft = pick(draft, FEATURES, "Sync");

    expect(draft[FEATURES.header]).toEqual({ picks: ["Search"], text: "Offline mode" });
  });

  it("counts a question as answered by a pick or by non-blank text, not by blank text", () => {
    const empty = buildQuestionDraft(QUESTIONS);

    expect(isQuestionAnswered(pick(empty, STORAGE, "IndexedDB"), STORAGE)).toBe(true);
    expect(isQuestionAnswered(typeQuestionAnswer(empty, STORAGE, " a file "), STORAGE)).toBe(true);
    expect(isQuestionAnswered(typeQuestionAnswer(empty, STORAGE, "  \n "), STORAGE)).toBe(false);
    // A multiSelect question whose only pick is toggled off again has no answer.
    const toggledOff = pick(pick(empty, FEATURES, "Sync"), FEATURES, "Sync");
    expect(isQuestionAnswered(toggledOff, FEATURES)).toBe(false);
  });

  it("builds no answers while one question is unanswered", () => {
    const draft = pick(buildQuestionDraft(QUESTIONS), STORAGE, "localStorage");

    expect(buildQuestionAnswers(draft, QUESTIONS)).toBeNull();
  });

  it("builds a string per single-select question and a list per multiSelect question, picks in option order, then the trimmed text", () => {
    let draft = buildQuestionDraft(QUESTIONS);
    draft = pick(draft, STORAGE, "localStorage");
    // Picked out of option order, so the list's order cannot come from the clicks.
    draft = pick(draft, FEATURES, "Export");
    draft = pick(draft, FEATURES, "Sync");
    draft = typeQuestionAnswer(draft, FEATURES, "  Offline mode  ");

    expect(buildQuestionAnswers(draft, QUESTIONS)).toEqual({
      Storage: "localStorage",
      Features: ["Sync", "Export", "Offline mode"],
    });
  });

  it("answers a single-select question with its trimmed text, and leaves blank text out of a multiSelect list", () => {
    let draft = buildQuestionDraft(QUESTIONS);
    draft = typeQuestionAnswer(draft, STORAGE, "  a sqlite file \n");
    draft = pick(draft, FEATURES, "Search");
    draft = typeQuestionAnswer(draft, FEATURES, "   ");

    expect(buildQuestionAnswers(draft, QUESTIONS)).toEqual({
      Storage: "a sqlite file",
      Features: ["Search"],
    });
  });

  it("answers a multiSelect question with only typed text as a one-item list", () => {
    let draft = buildQuestionDraft(QUESTIONS);
    draft = pick(draft, STORAGE, "IndexedDB");
    draft = typeQuestionAnswer(draft, FEATURES, " Offline mode ");

    expect(buildQuestionAnswers(draft, QUESTIONS)).toEqual({
      Storage: "IndexedDB",
      Features: ["Offline mode"],
    });
  });

  describe("picking an option while the user has typed text", () => {
    const typed = typeQuestionAnswer(buildQuestionDraft(QUESTIONS), STORAGE, "a sqlite file");

    it("adds only the newlines needed to leave one blank line, and never removes a character", () => {
      const joined = (messageText: string): string =>
        pickQuestionOption(typed, STORAGE, "IndexedDB", messageText).messageText;

      expect(joined("Draft")).toBe("Draft\n\na sqlite file");
      expect(joined("Draft\n")).toBe("Draft\n\na sqlite file");
      expect(joined("Draft\r\n")).toBe("Draft\r\n\na sqlite file");
      expect(joined("Draft\n\n")).toBe("Draft\n\na sqlite file");
      expect(joined("Draft  \n\n\n")).toBe("Draft  \n\n\na sqlite file");
      expect(joined("Draft  ")).toBe("Draft  \n\na sqlite file");
    });

    it("moves the typed text exactly as typed, spaces and line breaks included", () => {
      const multiline = typeQuestionAnswer(
        buildQuestionDraft(QUESTIONS),
        STORAGE,
        "\n  first\n\n  second \n ",
      );

      const picked = pickQuestionOption(multiline, STORAGE, "IndexedDB", "Hi");

      expect(picked.messageText).toBe("Hi\n\n\n  first\n\n  second \n ");
    });

    it("appends the typed text to a blank message without a separator, keeping the blank message", () => {
      expect(pickQuestionOption(typed, STORAGE, "IndexedDB", "").messageText).toBe("a sqlite file");
      expect(pickQuestionOption(typed, STORAGE, "IndexedDB", " \n ").messageText).toBe(
        " \n a sqlite file",
      );
    });

    it("leaves the message exactly as it was when the typed text is blank", () => {
      const blank = typeQuestionAnswer(buildQuestionDraft(QUESTIONS), STORAGE, " \n ");

      const picked = pickQuestionOption(blank, STORAGE, "IndexedDB", "Draft\n");

      expect(picked.messageText).toBe("Draft\n");
      expect(picked.question[STORAGE.header]).toEqual({ picks: ["IndexedDB"], text: "" });
    });

    it("erases the typed text of a secret question and keeps it out of the message", () => {
      const secret: ApprovalQuestion = { ...STORAGE, secretWarning: "Shown in the clear" };
      const withSecret = typeQuestionAnswer(buildQuestionDraft(QUESTIONS), secret, "hunter2");

      const picked = pickQuestionOption(withSecret, secret, "IndexedDB", "Draft");

      expect(picked.question[STORAGE.header]).toEqual({ picks: ["IndexedDB"], text: "" });
      expect(picked.messageText).toBe("Draft");
    });

    it("keeps the typed text and the message as they were on a multiSelect question", () => {
      const withText = typeQuestionAnswer(buildQuestionDraft(QUESTIONS), FEATURES, "Offline mode");

      const picked = pickQuestionOption(withText, FEATURES, "Sync", "Draft\n");

      expect(picked.question[FEATURES.header]).toEqual({ picks: ["Sync"], text: "Offline mode" });
      expect(picked.messageText).toBe("Draft\n");
    });
  });
});
