/** Tests the actions of the pane, in the order the sheet shows them. */
import { describe, expect, it } from "vitest";
import { buildCard, FAILURE } from "./cards.testing";
import {
  buildAskingCard,
  buildDetail,
  buildDetailSession,
  buildQuestion,
  buildQuestionRequest,
} from "./task-detail.testing";
import { decideQuestionAnswers } from "./question-answers";
import { listTaskActions, type TaskActions } from "./task-actions";

/** Lists the actions of a Task with this `detail`, as the pane reads its failure and its question. */
const listActionsForDetail = (detail: ReturnType<typeof buildDetail>): TaskActions =>
  listTaskActions({ failure: detail.card.failure, question: decideQuestionAnswers(detail) });

/** Returns the ids of every action, in the order down the sheet. */
const listIdsDownTheSheet = (actions: TaskActions): readonly string[] =>
  [
    ...actions.failure,
    ...(actions.openThread === null ? [] : [actions.openThread]),
    ...actions.foot.start,
    actions.foot.end,
  ].map((action) => action.id);

const ASKING = buildDetailSession("s1", {
  openRequests: [
    buildQuestionRequest("r1", [buildQuestion("Refunds", { options: [{ label: "Yes" }] })]),
  ],
});

describe("the actions of the pane", () => {
  it("lists only the foot for a Task with nothing to do", () => {
    const actions = listActionsForDetail(buildDetail(buildCard("a")));
    expect(listIdsDownTheSheet(actions)).toEqual(["done", "start-thread", "merge", "drop"]);
    expect(actions.returnKey).toBeNull();
  });

  it("puts the foot's words and keys on the buttons", () => {
    const { foot } = listActionsForDetail(buildDetail(buildCard("a")));
    expect([...foot.start, foot.end].map((a) => [a.label, a.keyHint])).toEqual([
      ["Done", "D"],
      ["Start a thread", "T"],
      ["Merge", "M"],
      ["Drop", "⌫"],
    ]);
  });

  it("leads a failed Task with Try again, filled, then Open the run, and Return tries again", () => {
    const actions = listActionsForDetail(buildDetail(buildCard("a", { failure: FAILURE })));
    expect(listIdsDownTheSheet(actions)).toEqual([
      "try-again",
      "open-run",
      "done",
      "start-thread",
      "merge",
      "drop",
    ]);
    expect(actions.failure.map((a) => [a.label, a.filled])).toEqual([
      ["Try again", true],
      ["Open the run", false],
    ]);
    expect(actions.returnKey).toBe("try-again");
  });

  it("puts the question under the failure, and Return still tries again", () => {
    const card = { ...buildAskingCard("s1", "r1"), failure: FAILURE };
    const actions = listActionsForDetail(buildDetail(card, ASKING));
    expect(listIdsDownTheSheet(actions).slice(0, 3)).toEqual([
      "try-again",
      "open-run",
      "open-thread",
    ]);
    expect(actions.returnKey).toBe("try-again");
  });

  it("offers Open thread under a question, and Return sends the suggested answer", () => {
    const actions = listActionsForDetail(buildDetail(buildAskingCard("s1", "r1"), ASKING));
    expect(listIdsDownTheSheet(actions)).toEqual([
      "open-thread",
      "done",
      "start-thread",
      "merge",
      "drop",
    ]);
    expect(actions.returnKey).toBe("send-suggested-answer");
  });

  it("gives Return nothing to send for a question with no chips", () => {
    const asking = buildDetailSession("s1", {
      openRequests: [buildQuestionRequest("r1", [buildQuestion("Why")])],
    });
    const actions = listActionsForDetail(buildDetail(buildAskingCard("s1", "r1"), asking));
    expect(actions.openThread?.id).toBe("open-thread");
    expect(actions.returnKey).toBeNull();
  });

  it("offers Open thread on a question the pane only shows, and gives Return nothing", () => {
    const several = buildDetailSession("s1", {
      openRequests: [buildQuestionRequest("r1", [buildQuestion("A"), buildQuestion("B")])],
    });
    const actions = listActionsForDetail(buildDetail(buildAskingCard("s1", "r1"), several));
    expect(actions.openThread?.id).toBe("open-thread");
    expect(actions.returnKey).toBeNull();
  });

  it("offers no Open thread when the question closed", () => {
    const actions = listActionsForDetail(
      buildDetail(buildAskingCard("s1", "r1"), buildDetailSession("s1")),
    );
    expect(actions.openThread).toBeNull();
  });

  it("takes the failure from the facts it is given, apart from the question", () => {
    const question = decideQuestionAnswers(buildDetail(buildAskingCard("s1", "r1"), ASKING));
    const actions = listTaskActions({ failure: FAILURE, question });
    expect(actions.failure.map((a) => a.id)).toEqual(["try-again", "open-run"]);
    expect(actions.openThread?.id).toBe("open-thread");
    expect(listTaskActions({ failure: undefined, question }).failure).toEqual([]);
  });
});
