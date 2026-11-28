/** Tests which question the pane shows, whether it answers it, and the answers it builds. */
import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_LENGTH } from "@hercule/contract";
import { buildCard, FAILURE } from "./cards.testing";
import {
  buildApprovalRequest,
  buildAskingCard,
  buildDetail,
  buildDetailSession,
  buildQuestion,
  buildQuestionRequest,
} from "./task-detail.testing";
import {
  buildPaneAnswers,
  decideQuestionAnswers,
  type AnswerableTaskQuestion,
} from "./question-answers";

const REFUNDS = buildQuestion("Refunds", {
  options: [
    { label: "Original card", description: "Fastest for the customer." },
    { label: "Store credit" },
  ],
});

/** Returns the pane's view of a Thread "s1" holding `request` as its open Request. */
const detailWith = (request: ReturnType<typeof buildQuestionRequest>) =>
  buildDetail(
    buildAskingCard("s1", request.requestId),
    buildDetailSession("s1", { title: "Refund flow", openRequests: [request] }),
  );

const answerable = (question: ReturnType<typeof decideQuestionAnswers>): AnswerableTaskQuestion => {
  if (question?.kind !== "answerable") throw new Error("expected an answerable question");
  return question;
};

describe("which question the pane shows", () => {
  it("answers a question with one choice and options, with the first option suggested", () => {
    const shown = decideQuestionAnswers(detailWith(buildQuestionRequest("r1", [REFUNDS])));
    expect(shown).toEqual({
      kind: "answerable",
      sessionId: "s1",
      requestId: "r1",
      asker: null,
      question: "Should refunds go back to the original card?",
      header: "Refunds",
      chips: [
        { label: "Original card", description: "Fastest for the customer.", suggested: true },
        { label: "Store credit", suggested: false },
      ],
      placeholder: "Or say something else…",
    });
  });

  it("answers a question with no options by free text alone", () => {
    const shown = answerable(
      decideQuestionAnswers(detailWith(buildQuestionRequest("r1", [buildQuestion("Why")]))),
    );
    expect(shown.chips).toEqual([]);
    expect(shown.placeholder).toBe("Type your answer");
  });

  it("names the subagent that asks", () => {
    const request = buildQuestionRequest("r1", [REFUNDS], { subagentName: "Policy reader" });
    expect(decideQuestionAnswers(detailWith(request))?.asker).toBe("Policy reader");
  });

  it("names no asker for a Thread with no role, and the role when it has one", () => {
    const request = buildQuestionRequest("r1", [REFUNDS]);
    const detail = buildDetail(
      buildAskingCard("s1", "r1"),
      buildDetailSession("s1", { role: " review ", openRequests: [request] }),
    );
    expect(decideQuestionAnswers(detail)?.asker).toBe("review");
    expect(decideQuestionAnswers(detailWith(request))?.asker).toBeNull();
  });

  it("words a question the agent asked with no text", () => {
    const request = buildQuestionRequest("r1", [buildQuestion("Why", { question: "  " })]);
    expect(decideQuestionAnswers(detailWith(request))?.question).toBe("Has a question");
  });

  it.each([
    [
      "several questions",
      buildQuestionRequest("r1", [
        REFUNDS,
        buildQuestion("Shipping", { question: "Which carrier?" }),
      ]),
    ],
    ["a multiSelect question", buildQuestionRequest("r1", [{ ...REFUNDS, multiSelect: true }])],
    ["a secret question", buildQuestionRequest("r1", [{ ...REFUNDS, secret: true }])],
  ])("only shows %s and leads to the Thread", (_, request) => {
    expect(decideQuestionAnswers(detailWith(request))).toEqual({
      kind: "open-thread",
      sessionId: "s1",
      requestId: "r1",
      asker: null,
      question: "Should refunds go back to the original card?",
    });
  });

  it("shows the first question's words when there are several", () => {
    const request = buildQuestionRequest("r1", [
      buildQuestion("A", { question: "First?" }),
      buildQuestion("B", { question: "Second?" }),
    ]);
    expect(decideQuestionAnswers(detailWith(request))?.question).toBe("First?");
  });

  it("shows nothing when the card names no question", () => {
    const detail = buildDetail(buildCard("task-1", { failure: FAILURE }), buildDetailSession("s1"));
    expect(decideQuestionAnswers(detail)).toBeNull();
  });

  it("shows nothing when the Request closed", () => {
    const detail = buildDetail(buildAskingCard("s1", "r1"), buildDetailSession("s1"));
    expect(decideQuestionAnswers(detail)).toBeNull();
  });

  it("shows nothing when the Thread is not among the listed ones", () => {
    const detail = buildDetail(buildAskingCard("s9", "r1"), buildDetailSession("s1"));
    expect(decideQuestionAnswers(detail)).toBeNull();
  });

  it("shows nothing for another Request of the Thread than the one the card names", () => {
    const detail = buildDetail(
      buildAskingCard("s1", "r2"),
      buildDetailSession("s1", { openRequests: [buildQuestionRequest("r1", [REFUNDS])] }),
    );
    expect(decideQuestionAnswers(detail)).toBeNull();
  });

  it("never shows an approval as a question", () => {
    const detail = buildDetail(
      buildAskingCard("s1", "r1"),
      buildDetailSession("s1", { openRequests: [buildApprovalRequest("r1")] }),
    );
    expect(decideQuestionAnswers(detail)).toBeNull();
  });
});

describe("the answers the pane builds", () => {
  const question = answerable(
    decideQuestionAnswers(detailWith(buildQuestionRequest("r1", [REFUNDS]))),
  );

  it("answers with the label of a chip", () => {
    expect(buildPaneAnswers(question, { kind: "chip", label: "Store credit" })).toEqual({
      kind: "send",
      answers: { Refunds: "Store credit" },
    });
  });

  it("answers with the user's own words, trimmed", () => {
    expect(buildPaneAnswers(question, { kind: "text", text: "  Ask Dana first \n" })).toEqual({
      kind: "send",
      answers: { Refunds: "Ask Dana first" },
    });
  });

  it("refuses blank text without a notice", () => {
    expect(buildPaneAnswers(question, { kind: "text", text: "  \n" })).toEqual({
      kind: "refuse",
      notice: null,
    });
  });

  it("refuses text longer than the composer allows, and says why", () => {
    const result = buildPaneAnswers(question, {
      kind: "text",
      text: "x".repeat(MAX_MESSAGE_LENGTH + 1),
    });
    expect(result).toEqual({
      kind: "refuse",
      notice: `This answer is longer than ${MAX_MESSAGE_LENGTH.toLocaleString("en-US")} characters.`,
    });
  });
});
