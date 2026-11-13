/**
 * Tests answering a card's question from the Work details pane through the
 * rendered app: the undo window before the answer is sent, Undo, a refused
 * send and Send again, leaving Work during the window, and an answer left
 * over from a closed app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildSession } from "@hercule/client-core/threads/testing";
import { buildBoard } from "@hercule/client-core/work/testing";
import type { TaskDetail } from "@hercule/contract";
import {
  CONTROLLER_URL,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubIntersectionObserver,
  type Handler,
} from "../../../app/testing";
import { buildPendingIntentsKey } from "../../../app/pending-intents";
import {
  buildDetail,
  buildTaskId,
  CARDS,
  detailPath,
  getCard,
  listCalls,
  openWork,
  holdUndoWindow,
  THREAD_ID,
  endUndoWindow,
} from "./-work.testing";

// The board stops the paws of a working colleague whose card is out of view.
beforeEach(() => {
  stubIntersectionObserver();
});

afterEach(() => {
  setVisibility("visible");
  localStorage.clear();
});

const RESPOND_PATH = `POST /api/v1/sessions/${THREAD_ID}/respond-to-question`;
const ASKING = CARDS[0]!;
const ASKING_REQUEST_ID = ASKING.openQuestion!.requestId;

/** Returns the Task details of the asking card: one Thread holding its question, with two options. */
const buildAskingDetail = (): TaskDetail =>
  buildDetail(ASKING, {
    sessions: [
      {
        id: THREAD_ID,
        title: "Currencies",
        role: null,
        kind: "thread",
        status: "idle",
        openRequests: [
          {
            requestId: ASKING_REQUEST_ID,
            itemId: "item-1",
            kind: "question",
            detail: {
              questions: [
                {
                  header: "Currency",
                  question: "Which currency should win?",
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
  });

/** The answer of a send the controller takes. */
const ANSWER_TAKEN = {
  body: buildSession({
    id: THREAD_ID,
    permissionProfileId: buildTaskId(960),
    providerAccountId: buildTaskId(961),
    runnerId: buildTaskId(962),
  }),
};

/**
 * Opens Work with the asking card. `respond` answers each send. After the
 * first send it is taken, the board shows the card with no question, as the
 * controller does once the Thread moved on.
 */
const openAsking = async (respond: (attempt: number) => Handler = () => () => ANSWER_TAKEN) => {
  let sends = 0;
  const { openQuestion, ...answered } = ASKING;
  void openQuestion;
  return {
    ...(await openWork({
      board: () => buildBoard(sends > 0 ? answered : ASKING, ...CARDS.slice(1)),
      handlers: {
        [detailPath(ASKING.id)]: () => ({ body: buildAskingDetail() }),
        [RESPOND_PATH]: (call) => {
          sends += 1;
          const handler = respond(sends);
          return typeof handler === "function" ? handler(call) : handler;
        },
      },
    })),
  };
};

/** Opens the asking card's details and returns the pane, once its chips are there. */
const openAskingPane = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
  await user.click(
    await screen.findByRole("button", { name: /^Refund emails show the wrong currency/ }),
  );
  const pane = await screen.findByRole("dialog", { name: "Refund emails show the wrong currency" });
  await within(pane).findByRole("textbox", { name: "Your answer" });
  return pane;
};

const REFUSED_WHILE_AWAY = {
  status: 409,
  body: { error: { code: "invalid_state", message: "The runner is away." } },
};
const REFUSED_CLOSED = {
  status: 409,
  body: {
    error: {
      code: "invalid_state",
      message: "That question is not open.",
      details: { reason: "request-closed" },
    },
  },
};

describe("answering a question from the details pane", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes the sheet at once, draws the card as answered, and sends after the undo window", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openAsking();
    const pane = await openAskingPane(user);
    holdUndoWindow();

    await user.click(within(pane).getByRole("button", { name: "The shop's" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByText("Answered “The shop's”.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Undo/ })).toBeTruthy();
    expect(getCard("Refund emails show the wrong currency").textContent).not.toContain(
      "Which currency should win?",
    );
    // The card says what was answered while the answer is held, as the drawing does.
    expect(getCard("Refund emails show the wrong currency").textContent).toContain(
      "You said: “The shop's”.",
    );
    expect(listCalls(calls, RESPOND_PATH)).toHaveLength(0);

    await endUndoWindow();
    await waitFor(() => {
      expect(listCalls(calls, RESPOND_PATH)).toHaveLength(1);
    });
    expect(listCalls(calls, RESPOND_PATH)[0]?.body).toEqual({
      requestId: ASKING_REQUEST_ID,
      answers: { Currency: "The shop's" },
    });
    // The card stays answered once the send ended: the board read after it shows no question.
    await waitFor(() => {
      expect(getCard("Refund emails show the wrong currency").textContent).not.toContain(
        "Which currency should win?",
      );
    });
  });

  it("sends the suggested answer with Return on the card the pane was opened from", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openAsking();
    await openAskingPane(user);
    holdUndoWindow();
    // The pane ignores a Return pressed just as it showed the Task.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(document.activeElement).toBe(getCard("Refund emails show the wrong currency"));

    await user.keyboard("{Enter}");

    expect(await screen.findByText("Answered “The shop's”.")).toBeTruthy();
    await endUndoWindow();
    await waitFor(() => {
      expect(listCalls(calls, RESPOND_PATH)).toHaveLength(1);
    });
  });

  it("sends the words the user typed, and sends nothing when Undo is pressed", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openAsking();
    const pane = await openAskingPane(user);
    holdUndoWindow();

    await user.type(within(pane).getByRole("textbox", { name: "Your answer" }), "Both{Enter}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByText("Answered “Both”.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^Undo/ }));
    await endUndoWindow();

    expect(listCalls(calls, RESPOND_PATH)).toHaveLength(0);
    expect(screen.getByText("Put back: Answered “Both”.")).toBeTruthy();
    // The question is back on its card.
    expect(getCard("Refund emails show the wrong currency").textContent).toContain(
      "Which currency should win?",
    );
  });

  it("keeps the words, brings the question back, and offers Send again when the send is refused", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openAsking((attempt) =>
      attempt === 1 ? REFUSED_WHILE_AWAY : () => ANSWER_TAKEN,
    );
    const pane = await openAskingPane(user);
    holdUndoWindow();
    await user.click(within(pane).getByRole("button", { name: "The shop's" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    await endUndoWindow();

    await waitFor(() => {
      expect(getCard("Refund emails show the wrong currency").textContent).toContain(
        "Which currency should win?",
      );
    });
    const reopened = await openAskingPane(user);
    expect(within(reopened).getByText("Your answer: “The shop's”")).toBeTruthy();
    expect(within(reopened).getByText("It was not sent: The runner is away.")).toBeTruthy();

    await user.click(within(reopened).getByRole("button", { name: "Send again" }));

    await waitFor(() => {
      expect(listCalls(calls, RESPOND_PATH)).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.queryByText("Your answer: “The shop's”")).toBeNull();
    });
  });

  it("says the question is no longer open when Send again is refused for it, and never sends the words again", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openAsking((attempt) =>
      attempt === 1 ? REFUSED_WHILE_AWAY : REFUSED_CLOSED,
    );
    const pane = await openAskingPane(user);
    holdUndoWindow();
    await user.click(within(pane).getByRole("button", { name: "The shop's" }));
    await endUndoWindow();
    await waitFor(() => {
      expect(getCard("Refund emails show the wrong currency").textContent).toContain(
        "Which currency should win?",
      );
    });
    const reopened = await openAskingPane(user);

    await user.click(within(reopened).getByRole("button", { name: "Send again" }));

    expect(
      await within(reopened).findByText(
        "This question is no longer open, and your answer may have reached it.",
      ),
    ).toBeTruthy();
    expect(within(reopened).getByText("Your answer: “The shop's”")).toBeTruthy();
    expect(within(reopened).queryByRole("button", { name: "Send again" })).toBeNull();
    await endUndoWindow();
    expect(listCalls(calls, RESPOND_PATH)).toHaveLength(2);

    await user.click(within(reopened).getByRole("button", { name: "Discard" }));

    expect(within(reopened).queryByText("Your answer: “The shop's”")).toBeNull();
  });

  it("still sends when the user leaves Work during the undo window", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls, router } = await openAsking();
    const pane = await openAskingPane(user);
    holdUndoWindow();
    await user.click(within(pane).getByRole("button", { name: "The shop's" }));

    await act(() => router.navigate({ to: "/" }));
    await endUndoWindow();

    await waitFor(() => {
      expect(listCalls(calls, RESPOND_PATH)).toHaveLength(1);
    });
  });

  it("shows an answer left over from a closed app as unsent, and never sends it by itself", async () => {
    const user = userEvent.setup({ delay: null });
    localStorage.setItem(
      buildPendingIntentsKey(CONTROLLER_URL, SIDEBAR_FIXTURE.username),
      JSON.stringify([
        {
          intentId: "left-over",
          kind: "answer",
          taskId: ASKING.id,
          sessionId: THREAD_ID,
          requestId: ASKING_REQUEST_ID,
          answers: { Currency: "The shop's" },
          state: "pending",
          failure: null,
        },
      ]),
    );
    const { calls } = await openAsking();
    holdUndoWindow();

    const pane = await openAskingPane(user);

    expect(within(pane).getByText("Your answer: “The shop's”")).toBeTruthy();
    expect(within(pane).getByText("The app closed before it was sent.")).toBeTruthy();
    expect(within(pane).getByRole("button", { name: "Send again" })).toBeTruthy();
    await endUndoWindow();
    expect(listCalls(calls, RESPOND_PATH)).toHaveLength(0);
  });
});
