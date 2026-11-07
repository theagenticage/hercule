/** Tests what the details pane shows and does for a Task, in the order the sheet shows it. */
import { describe, expect, it } from "vitest";
import type { QuestionAnswers, WorkCard } from "@hercule/contract";
import { buildCard, FAILURE } from "./cards.testing";
import {
  buildAskingCard,
  buildDetail,
  buildDetailSession,
  buildQuestion,
  buildQuestionRequest,
} from "./task-detail.testing";
import { buildTaskPane, type TaskActions, type TaskPaneFacts } from "./task-pane";

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
const NO_CHIPS = buildDetailSession("s1", {
  openRequests: [buildQuestionRequest("r1", [buildQuestion("Why")])],
});
const SEVERAL = buildDetailSession("s1", {
  openRequests: [buildQuestionRequest("r1", [buildQuestion("A"), buildQuestion("B")])],
});
const ANSWERED: QuestionAnswers = { Refunds: "Yes" };
const FAILED_ASKING = { ...buildAskingCard("s1", "r1"), failure: FAILURE };

/** Builds the pane of the Task "task-1" (the id the test cards use), with `facts` over a quiet default. */
const build = (facts: Partial<TaskPaneFacts> & Pick<TaskPaneFacts, "detail">) =>
  buildTaskPane({
    taskId: "task-1",
    boardCards: [],
    isGone: false,
    heldAnswers: [],
    unsentAnswers: [],
    ...facts,
  });

const FOOT = ["done", "start-thread", "merge", "drop"];

describe("the details pane of a Task", () => {
  const table: readonly {
    readonly name: string;
    readonly facts: Pick<TaskPaneFacts, "detail"> & Partial<TaskPaneFacts>;
    readonly down: readonly string[];
    readonly returnKind: string | null;
    readonly question: string | null;
    readonly said: boolean;
  }[] = [
    {
      name: "a quiet Task has only the foot, and Return does nothing",
      facts: { detail: buildDetail(buildCard("task-1")) },
      down: FOOT,
      returnKind: null,
      question: null,
      said: false,
    },
    {
      name: "a failed Task leads with Try again, and Return tries again",
      facts: { detail: buildDetail(buildCard("task-1", { failure: FAILURE })) },
      down: ["try-again", "open-run", ...FOOT],
      returnKind: "try-again",
      question: null,
      said: false,
    },
    {
      name: "a question sits under a failure, and Return still tries again",
      facts: { detail: buildDetail(FAILED_ASKING, ASKING) },
      down: ["try-again", "open-run", "open-thread", ...FOOT],
      returnKind: "try-again",
      question: "r1",
      said: false,
    },
    {
      name: "a question the pane answers has Open thread, and Return sends the suggested answer",
      facts: { detail: buildDetail(buildAskingCard("s1", "r1"), ASKING) },
      down: ["open-thread", ...FOOT],
      returnKind: "send-suggested-answer",
      question: "r1",
      said: false,
    },
    {
      name: "a question with no chips gives Return nothing to send",
      facts: { detail: buildDetail(buildAskingCard("s1", "r1"), NO_CHIPS) },
      down: ["open-thread", ...FOOT],
      returnKind: null,
      question: "r1",
      said: false,
    },
    {
      name: "a question the pane only shows has Open thread and gives Return nothing",
      facts: { detail: buildDetail(buildAskingCard("s1", "r1"), SEVERAL) },
      down: ["open-thread", ...FOOT],
      returnKind: null,
      question: "r1",
      said: false,
    },
    {
      name: "a question that closed offers no Open thread",
      facts: { detail: buildDetail(buildAskingCard("s1", "r1"), buildDetailSession("s1")) },
      down: FOOT,
      returnKind: null,
      question: null,
      said: false,
    },
    {
      name: "an answer held for the question gives way to its words, and Return sends nothing again",
      facts: {
        detail: buildDetail(buildAskingCard("s1", "r1"), ASKING),
        heldAnswers: [{ sessionId: "s1", requestId: "r1", answers: ANSWERED }],
      },
      down: ["open-thread", ...FOOT],
      returnKind: null,
      question: "r1",
      said: true,
    },
    {
      name: "an answer held for another question changes nothing",
      facts: {
        detail: buildDetail(buildAskingCard("s1", "r1"), ASKING),
        heldAnswers: [{ sessionId: "s1", requestId: "r2", answers: ANSWERED }],
      },
      down: ["open-thread", ...FOOT],
      returnKind: "send-suggested-answer",
      question: "r1",
      said: false,
    },
    {
      name: "a Task that no longer exists offers nothing to do",
      facts: { detail: buildDetail(FAILED_ASKING, ASKING), isGone: true },
      down: [],
      returnKind: null,
      question: "r1",
      said: false,
    },
  ];

  it.each(table)("$name", ({ facts, down, returnKind, question, said }) => {
    const pane = build(facts);
    expect(pane.actions === null ? [] : listIdsDownTheSheet(pane.actions)).toEqual(down);
    expect(pane.actions?.returnAction?.kind ?? null).toBe(returnKind);
    expect(pane.question?.requestId ?? null).toBe(question);
    expect(pane.said !== null).toBe(said);
  });

  it("puts the foot's words and keys on the buttons", () => {
    const foot = build({ detail: buildDetail(buildCard("task-1")) }).actions?.foot;
    expect([...(foot?.start ?? []), foot?.end].map((a) => [a?.label, a?.keyHint])).toEqual([
      ["Done", "D"],
      ["Start a thread", "T"],
      ["Merge", "M"],
      ["Drop", "⌫"],
    ]);
  });

  it("fills Try again and not Open the run", () => {
    const actions = build({ detail: buildDetail(FAILED_ASKING, ASKING) }).actions;
    expect(actions?.failure.map((a) => [a.label, a.filled])).toEqual([
      ["Try again", true],
      ["Open the run", false],
    ]);
  });

  it("makes Return send the suggested chip of the question it holds", () => {
    const action = build({ detail: buildDetail(buildAskingCard("s1", "r1"), ASKING) }).actions
      ?.returnAction;
    expect(action).toMatchObject({
      kind: "send-suggested-answer",
      question: { requestId: "r1" },
      answer: { kind: "chip", label: "Yes" },
    });
  });

  describe("which card it reads", () => {
    const onBoard = buildCard("task-1", { title: "On the board" });
    const inDetail = buildCard("task-1", { title: "In the details" });

    it("prefers the board's card, which is the newer", () => {
      expect(build({ boardCards: [onBoard], detail: buildDetail(inDetail) }).card).toBe(onBoard);
    });

    it("falls back to the card of the details when the board has none", () => {
      const detail = buildDetail(inDetail);
      expect(build({ boardCards: [buildCard("other")], detail }).card).toBe(inDetail);
    });

    it("has none before the first read of a Task that is not on the board", () => {
      const pane = build({ detail: undefined });
      expect(pane.card).toBeUndefined();
      expect(pane.actions).toBeNull();
    });

    it("takes the failure from the board's card and the question from the details", () => {
      // The board's card has the question taken off while an answer is held, and
      // is the one that knows a new failure; the details' card is older.
      const board: WorkCard = { ...buildCard("task-1"), failure: FAILURE };
      const pane = build({
        boardCards: [board],
        detail: buildDetail(buildAskingCard("s1", "r1"), ASKING),
      });
      expect(pane.actions?.failure.map((a) => a.id)).toEqual(["try-again", "open-run"]);
      expect(pane.question?.requestId).toBe("r1");
    });
  });

  it("describes the answers that were not sent", () => {
    const pane = build({
      detail: buildDetail(buildCard("task-1")),
      unsentAnswers: [
        {
          intentId: "i1",
          sessionId: "s1",
          answers: ANSWERED,
          failure: { reason: "interrupted", message: "The app quit." },
        },
      ],
    });
    expect(pane.unsent.map((each) => [each.intentId, each.said])).toEqual([
      ["i1", "Your answer: “Yes”"],
    ]);
  });
});
