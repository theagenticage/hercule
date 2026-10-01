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
    draft = pickQuestionOption(draft, STORAGE, "localStorage");
    draft = pickQuestionOption(draft, STORAGE, "IndexedDB");

    expect(draft[STORAGE.header]).toEqual({ picks: ["IndexedDB"], text: "" });
  });

  it("clears the pick when the user types on a single-select question", () => {
    let draft = buildQuestionDraft(QUESTIONS);
    draft = pickQuestionOption(draft, STORAGE, "localStorage");
    draft = typeQuestionAnswer(draft, STORAGE, "a sqlite file");

    expect(draft[STORAGE.header]).toEqual({ picks: [], text: "a sqlite file" });
  });

  it("toggles a picked option on a multiSelect question, and keeps the typed text", () => {
    let draft = buildQuestionDraft(QUESTIONS);
    draft = typeQuestionAnswer(draft, FEATURES, "Offline mode");
    draft = pickQuestionOption(draft, FEATURES, "Sync");
    draft = pickQuestionOption(draft, FEATURES, "Search");
    draft = pickQuestionOption(draft, FEATURES, "Sync");

    expect(draft[FEATURES.header]).toEqual({ picks: ["Search"], text: "Offline mode" });
  });

  it("counts a question as answered by a pick or by non-blank text, not by blank text", () => {
    const empty = buildQuestionDraft(QUESTIONS);

    expect(isQuestionAnswered(pickQuestionOption(empty, STORAGE, "IndexedDB"), STORAGE)).toBe(true);
    expect(isQuestionAnswered(typeQuestionAnswer(empty, STORAGE, " a file "), STORAGE)).toBe(true);
    expect(isQuestionAnswered(typeQuestionAnswer(empty, STORAGE, "  \n "), STORAGE)).toBe(false);
    // A multiSelect question whose only pick is toggled off again has no answer.
    const toggledOff = pickQuestionOption(
      pickQuestionOption(empty, FEATURES, "Sync"),
      FEATURES,
      "Sync",
    );
    expect(isQuestionAnswered(toggledOff, FEATURES)).toBe(false);
  });

  it("builds no answers while one question is unanswered", () => {
    const draft = pickQuestionOption(buildQuestionDraft(QUESTIONS), STORAGE, "localStorage");

    expect(buildQuestionAnswers(draft, QUESTIONS)).toBeNull();
  });

  it("builds a string per single-select question and a list per multiSelect question, picks in option order, then the trimmed text", () => {
    let draft = buildQuestionDraft(QUESTIONS);
    draft = pickQuestionOption(draft, STORAGE, "localStorage");
    // Picked out of option order, so the list's order cannot come from the clicks.
    draft = pickQuestionOption(draft, FEATURES, "Export");
    draft = pickQuestionOption(draft, FEATURES, "Sync");
    draft = typeQuestionAnswer(draft, FEATURES, "  Offline mode  ");

    expect(buildQuestionAnswers(draft, QUESTIONS)).toEqual({
      Storage: "localStorage",
      Features: ["Sync", "Export", "Offline mode"],
    });
  });

  it("answers a single-select question with its trimmed text, and leaves blank text out of a multiSelect list", () => {
    let draft = buildQuestionDraft(QUESTIONS);
    draft = typeQuestionAnswer(draft, STORAGE, "  a sqlite file \n");
    draft = pickQuestionOption(draft, FEATURES, "Search");
    draft = typeQuestionAnswer(draft, FEATURES, "   ");

    expect(buildQuestionAnswers(draft, QUESTIONS)).toEqual({
      Storage: "a sqlite file",
      Features: ["Search"],
    });
  });

  it("answers a multiSelect question with only typed text as a one-item list", () => {
    let draft = buildQuestionDraft(QUESTIONS);
    draft = pickQuestionOption(draft, STORAGE, "IndexedDB");
    draft = typeQuestionAnswer(draft, FEATURES, " Offline mode ");

    expect(buildQuestionAnswers(draft, QUESTIONS)).toEqual({
      Storage: "IndexedDB",
      Features: ["Offline mode"],
    });
  });
});
