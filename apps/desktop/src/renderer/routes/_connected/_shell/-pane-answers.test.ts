/** Tests `answerFromPane`: an answer goes to the question the pane drew, and only once. */
import { describe, expect, it, vi } from "vitest";
import { buildTaskPane, type AnswerableTaskQuestion } from "@hercule/client-core/work";
import { buildCard } from "@hercule/client-core/work/testing";
import type { TaskDetail } from "@hercule/contract";
import { createPendingIntents } from "../../../app/pending-intents";
import { answerFromPane, type PaneAnswerCallbacks } from "./-pane-answers";

/** Returns the details of a Task whose one Thread asks the question `requestId`, with two options. */
const buildAskingDetail = (requestId: string, question: string): TaskDetail =>
  ({
    task: { id: "task-1" },
    card: buildCard("task-1", {
      openQuestion: { sessionId: "session-1", requestId, text: question },
    }),
    sessions: [
      {
        id: "session-1",
        title: "Currencies",
        role: null,
        kind: "thread",
        status: "idle",
        openRequests: [
          {
            requestId,
            itemId: `item-${requestId}`,
            kind: "question",
            detail: {
              questions: [
                {
                  header: "Currency",
                  question,
                  options: [{ label: "The shop's" }, { label: "The customer's" }],
                  multiSelect: false,
                },
              ],
            },
          },
        ],
        done: false,
      },
    ],
    sessionCount: 1,
    runs: [],
    runCount: 0,
  }) as unknown as TaskDetail;

const readQuestion = (detail: TaskDetail): AnswerableTaskQuestion => {
  const { question } = buildTaskPane({
    taskId: "task-1",
    boardCards: [],
    detail,
    isGone: false,
    heldAnswers: [],
    unsentAnswers: [],
  });
  if (question?.kind !== "answerable") throw new Error("The test question is not answerable.");
  return question;
};

const setUp = () => {
  const store = createPendingIntents({
    storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    storageKey: "test",
    send: () => new Promise(() => undefined),
  });
  const callbacks: PaneAnswerCallbacks = {
    sayWithUndo: vi.fn(() => () => undefined),
    sayWithoutUndo: vi.fn(),
    closePane: vi.fn(),
  };
  return { store, callbacks };
};

describe("answerFromPane", () => {
  it("answers the question that was drawn", () => {
    const { store, callbacks } = setUp();

    answerFromPane(
      store,
      "task-1",
      readQuestion(buildAskingDetail("request-a", "Which currency should win?")),
      { kind: "chip", label: "The shop's" },
      callbacks,
    );

    expect(store.getSnapshot()).toMatchObject([
      { kind: "answer", sessionId: "session-1", requestId: "request-a" },
    ]);
    expect(callbacks.closePane).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("holds one answer however often the question is answered", () => {
    const { store, callbacks } = setUp();
    const question = readQuestion(buildAskingDetail("request-a", "Which currency should win?"));

    answerFromPane(store, "task-1", question, { kind: "chip", label: "The shop's" }, callbacks);
    answerFromPane(store, "task-1", question, { kind: "chip", label: "The customer's" }, callbacks);

    expect(store.getSnapshot()).toHaveLength(1);
    expect(callbacks.closePane).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("holds nothing and keeps the pane open for blank words, and says why when there is a reason", () => {
    const { store, callbacks } = setUp();
    const question = readQuestion(buildAskingDetail("request-a", "Which currency should win?"));

    answerFromPane(store, "task-1", question, { kind: "text", text: "   " }, callbacks);

    expect(store.getSnapshot()).toEqual([]);
    expect(callbacks.closePane).not.toHaveBeenCalled();
    store.dispose();
  });
});
