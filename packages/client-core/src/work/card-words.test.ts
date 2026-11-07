/** Tests the second line of a card and the name a screen reader reads for a card. */
import { describe, expect, it } from "vitest";
import { buildCard, buildSummary, FAILURE, QUESTION } from "./cards.testing";
import {
  chooseCardSecondLine,
  describeCardForReader,
  type CardSecondLine,
  type ShownWorkCard,
} from "./card-words";

describe("the line of a failed card", () => {
  it.each([
    ["with a cause", "the branch changed mid-run", "Review PR failed: the branch changed mid-run."],
    ["with no cause", "", "Review PR failed."],
    ["with a cause of only spaces", "  \n ", "Review PR failed."],
    [
      "with a cause that ends in a full stop",
      "Exited with code 1.",
      "Review PR failed: Exited with code 1.",
    ],
    ["with a cause of several lines", "first\n  second", "Review PR failed: first second."],
  ])("writes the line %s", (_, cause, expected) => {
    expect(
      chooseCardSecondLine(buildCard("a", { failure: { ...FAILURE, cause } }), true)?.text,
    ).toBe(expected);
  });
});

describe("the line of a card that asks a question", () => {
  it.each([
    ["the question", "Which refund window?", "Which refund window?"],
    ["a blank question", "", "Has a question"],
    ["a question of only whitespace", " \n ", "Has a question"],
  ])("is %s", (_, text, expected) => {
    expect(
      chooseCardSecondLine(buildCard("a", { openQuestion: { ...QUESTION, text } }), true)?.text,
    ).toBe(expected);
  });
});

describe("chooseCardSecondLine", () => {
  const SUMMARY = buildSummary("Three designs, depots worried.");

  const ROWS: ReadonlyArray<[string, Partial<ShownWorkCard>, CardSecondLine | null, boolean?]> = [
    [
      "what broke, over a question and a summary",
      { failure: FAILURE, openQuestion: QUESTION, summary: SUMMARY },
      { text: "Review PR failed: the branch changed mid-run.", tone: "failed" },
    ],
    [
      "the question, over a summary",
      { openQuestion: QUESTION, summary: SUMMARY },
      { text: "Should refunds go back to the original card?", tone: "question" },
    ],
    [
      "what broke, over a held answer",
      { failure: FAILURE, heldAnswer: "You said: “Ship it”." },
      { text: "Review PR failed: the branch changed mid-run.", tone: "failed" },
    ],
    [
      "a held answer, over a summary",
      { summary: SUMMARY, heldAnswer: "You said: “Ship it”." },
      { text: "You said: “Ship it”.", tone: "summary" },
    ],
    [
      "a held answer, for a Task with no summary yet",
      { heldAnswer: "You said: “Ship it”." },
      { text: "You said: “Ship it”.", tone: "summary" },
    ],
    [
      "the summary line",
      { summary: SUMMARY },
      { text: "Three designs, depots worried.", tone: "summary" },
    ],
    [
      "the same summary line when the summary is stale",
      { summary: { ...SUMMARY, stale: true } },
      { text: "Three designs, depots worried.", tone: "summary" },
    ],
    [
      "the summary line without the spaces around it",
      { summary: buildSummary("  Waiting on the depots \n") },
      { text: "Waiting on the depots", tone: "summary" },
    ],
    [
      "writing a summary, for a Task with none yet",
      {},
      { text: "Writing a summary", tone: "pending" },
    ],
    ["nothing, for a summary with a blank line", { summary: buildSummary("  ") }, null],
  ];

  it.each(ROWS)("is %s", (_, overrides, expected, canWriteSummaries = true) => {
    expect(chooseCardSecondLine(buildCard("a", overrides), canWriteSummaries)).toEqual(expected);
  });
});

describe("describeCardForReader", () => {
  const NOW = new Date("2026-11-04T09:00:00.000Z");
  const SUMMARY = buildSummary("Three designs, depots worried.");

  const ROWS: ReadonlyArray<[string, Partial<ShownWorkCard>, string, boolean?]> = [
    [
      "the title, the stage, the summary and the age",
      { stage: "in-review", summary: SUMMARY },
      "Add a refund button, In review, Three designs, depots worried., 3 days ago",
    ],
    [
      "that a summary is being written, for a Task with none",
      { stage: "in-review" },
      "Add a refund button, In review, Summary being written, 3 days ago",
    ],
    [
      "no summary words for a summary with a blank line",
      { stage: "in-review", summary: buildSummary("") },
      "Add a refund button, In review, 3 days ago",
    ],
    [
      "no summary words for a Task with none when Text Generation cannot run",
      { stage: "in-review" },
      "Add a refund button, In review, 3 days ago",
      false,
    ],
    [
      "a held answer in place of the summary",
      { stage: "in-review", summary: SUMMARY, heldAnswer: "You said: “Ship it”." },
      "Add a refund button, In review, You said: “Ship it”., 3 days ago",
    ],
    [
      "a blank question as Has a question, and no summary beside it",
      { stage: "building", openQuestion: { ...QUESTION, text: "" }, summary: SUMMARY },
      "Add a refund button, Has a question, Building, 3 days ago",
    ],
    [
      "what broke before what it asks, both before the stage, and no summary beside them",
      { stage: "building", failure: FAILURE, openQuestion: QUESTION, summary: SUMMARY },
      "Add a refund button, Review PR failed: the branch changed mid-run., Should refunds go back to the original card?, Building, 3 days ago",
    ],
  ];

  it.each(ROWS)("reads %s", (_, overrides, expected, canWriteSummaries = true) => {
    const card = buildCard("a", { title: "Add a refund button", ...overrides });
    expect(describeCardForReader(card, NOW, canWriteSummaries)).toBe(expected);
  });
});
