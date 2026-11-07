/**
 * Tests `answerFromPane`: an answer goes to the question the pane drew, never
 * to whichever question the cache holds when the click arrives.
 */
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@hercule/client-core";
import { decideQuestionAnswers, type AnswerableTaskQuestion } from "@hercule/client-core/work";
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
  const question = decideQuestionAnswers(detail);
  if (question?.kind !== "answerable") throw new Error("The test question is not answerable.");
  return question;
};

const setUp = () => {
  const queryClient = new QueryClient();
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
  return { queryClient, store, callbacks };
};

describe("answerFromPane", () => {
  it("answers the question that was drawn", () => {
    const { queryClient, store, callbacks } = setUp();
    const detail = buildAskingDetail("request-a", "Which currency should win?");
    queryClient.setQueryData(queryKeys.taskDetail("task-1"), detail);

    answerFromPane(
      queryClient,
      store,
      "task-1",
      readQuestion(detail),
      { kind: "chip", label: "The shop's" },
      callbacks,
    );

    expect(store.getSnapshot()).toMatchObject([
      { kind: "answer", sessionId: "session-1", requestId: "request-a" },
    ]);
    expect(callbacks.closePane).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("holds nothing when a push replaced the question after it was drawn, and says it is no longer open", () => {
    const { queryClient, store, callbacks } = setUp();
    const drawn = readQuestion(buildAskingDetail("request-a", "Which currency should win?"));
    // The cache now holds the Thread's next question, which the pane has not drawn yet.
    queryClient.setQueryData(
      queryKeys.taskDetail("task-1"),
      buildAskingDetail("request-b", "Which store should win?"),
    );

    answerFromPane(
      queryClient,
      store,
      "task-1",
      drawn,
      { kind: "chip", label: "The shop's" },
      callbacks,
    );

    expect(store.getSnapshot()).toEqual([]);
    expect(callbacks.closePane).not.toHaveBeenCalled();
    expect(callbacks.sayWithoutUndo).toHaveBeenCalledWith(
      "That question is no longer open. Open the thread to see it.",
    );
    store.dispose();
  });
});
