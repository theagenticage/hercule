/** Tests the words and the card changes for an answer given from the details pane. */
import { describe, expect, it } from "vitest";
import { buildCard, buildSummary, QUESTION } from "./cards.testing";
import { chooseCardSecondLine } from "./card-words";
import {
  describeAnswerGiven,
  describeHeldAnswer,
  describeUnsentAnswer,
  showHeldAnswers,
  type UnsentAnswerSource,
} from "./held-answers";

describe("the words of an answer", () => {
  it.each([
    ["one answer", { Refunds: "Store credit" }, "“Store credit”"],
    [
      "several choices, in order",
      { Refunds: ["Store credit", "Voucher"] },
      "“Store credit, Voucher”",
    ],
    ["white space folded", { Refunds: "  Store\n  credit " }, "“Store credit”"],
    ["a long answer cut with an ellipsis", { Why: "x".repeat(80) }, `“${"x".repeat(60)}…”`],
  ] as const)("quotes %s", (_name, answers, quoted) => {
    expect(describeAnswerGiven(answers)).toBe(`Answered ${quoted}`);
    expect(describeHeldAnswer(answers)).toBe(`You said: ${quoted}.`);
  });
});

describe("a card whose answer is held", () => {
  const ANSWERS = { Refunds: "Store credit" };
  const asking = buildCard("t1", { openQuestion: QUESTION });
  const other = buildCard("t2");

  it("draws the question as answered, and leaves every other card as it is", () => {
    const shown = showHeldAnswers(
      [asking, other],
      [{ sessionId: "session-1", requestId: "request-1", answers: ANSWERS }],
    );
    expect(shown[0]).not.toHaveProperty("openQuestion");
    expect(shown[0]?.title).toBe(asking.title);
    expect(shown[1]).toBe(other);
  });

  it("makes the second line say what was answered, in place of the question", () => {
    const [shown] = showHeldAnswers(
      [{ ...asking, summary: buildSummary("Three designs.") }],
      [{ sessionId: "session-1", requestId: "request-1", answers: ANSWERS }],
    );
    expect(shown && chooseCardSecondLine(shown, true)).toEqual({
      text: "You said: “Store credit”.",
      tone: "summary",
    });
  });

  it("matches the Thread and the Request, not the Task", () => {
    const cards = [asking];
    expect(
      showHeldAnswers(cards, [
        { sessionId: "session-1", requestId: "request-2", answers: ANSWERS },
      ]),
    ).toBe(cards);
    expect(
      showHeldAnswers(cards, [
        { sessionId: "session-2", requestId: "request-1", answers: ANSWERS },
      ]),
    ).toBe(cards);
  });

  it("returns the same array when nothing is held", () => {
    const cards = [asking, other];
    expect(showHeldAnswers(cards, [])).toBe(cards);
  });
});

describe("an answer that was not sent", () => {
  const source = (
    reason: UnsentAnswerSource["failure"]["reason"],
    message = "The runner is away.",
  ): UnsentAnswerSource => ({
    intentId: "i1",
    sessionId: "session-1",
    answers: { Refunds: "Store credit" },
    failure: { reason, message },
  });

  it("keeps the words and offers Send again after a failed send", () => {
    expect(describeUnsentAnswer(source("send-failed"))).toEqual({
      intentId: "i1",
      sessionId: "session-1",
      said: "Your answer: “Store credit”",
      notice: "It was not sent: The runner is away.",
      actions: [
        { id: "send-again", label: "Send again" },
        { id: "discard", label: "Discard" },
      ],
    });
  });

  it("says the app closed after a restart, and still offers Send again", () => {
    const unsent = describeUnsentAnswer(source("interrupted", "ignored"));
    expect(unsent.notice).toBe("The app closed before it was sent.");
    expect(unsent.actions.map((action) => action.id)).toEqual(["send-again", "discard"]);
  });

  it("says the question closed, keeps the words, and offers Open thread instead of Send again", () => {
    const unsent = describeUnsentAnswer(source("no-longer-open"));
    expect(unsent.notice).toBe(
      "This question is no longer open, and your answer may have reached it.",
    );
    expect(unsent.said).toBe("Your answer: “Store credit”");
    expect(unsent.actions.map((action) => action.id)).toEqual(["open-thread", "discard"]);
  });
});
