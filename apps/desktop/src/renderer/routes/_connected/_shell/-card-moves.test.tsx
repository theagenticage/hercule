/**
 * Tests moving cards through `useCardMoves`: a move shows at once and is sent
 * in order, a read that lands meanwhile cannot undo it, a failed move goes
 * back and says why, and Undo waits for its own request and puts the card
 * back where it stood. What the cards do on screen needs a real layout, so
 * these tests only check which spring a change is played on.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { buildBoard, buildCard, listIds } from "@hercule/client-core/work/testing";
import { buildWorkBoardKey } from "@hercule/client-core/work";
import type { WorkBoard } from "@hercule/contract";
import { flipByKey } from "../../../app/motion";
import { createUndoStack } from "../../../app/undo-stack";
import { useCardMoves } from "./-card-moves";

// The motion kernel measures a real layout. Here it only makes the change it is given and notes the spring.
vi.mock("../../../app/motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../app/motion")>()),
  flipByKey: vi.fn((options: { readonly mutate: () => void }) => {
    options.mutate();
  }),
}));

/** Returns the springs the board has been played on since the last call, oldest first. */
const takePlayedSprings = (): unknown[] => {
  const springs = vi.mocked(flipByKey).mock.calls.map(([options]) => options.spring);
  vi.mocked(flipByKey).mockClear();
  return springs;
};

const BOARD = buildBoard(
  buildCard("a", { stage: "building" }),
  buildCard("b", { stage: "building" }),
  buildCard("c", { stage: "in-review" }),
);

/** A request the test answers when it chooses. */
interface HeldMove {
  readonly payload: unknown;
  readonly taskId: string;
  readonly accept: () => void;
  readonly refuse: (message: string) => void;
}

/**
 * Returns a client whose `task.move` waits for the test to accept or refuse
 * each request, and whose board read answers with `readBoard()`.
 */
const buildClient = (readBoard: () => WorkBoard) => {
  const held: HeldMove[] = [];
  const client = {
    task: {
      queryBoard: () => Promise.resolve(readBoard()),
      move: ({ params, payload }: { params: { id: string }; payload: unknown }) =>
        new Promise((resolve, reject) => {
          held.push({
            payload,
            taskId: params.id,
            accept: () => {
              resolve({});
            },
            refuse: (message) => {
              reject(new Error(message));
            },
          });
        }),
    },
  } as unknown as HerculeClient;
  return { client, held };
};

const setUp = (readBoard: () => WorkBoard = () => BOARD) => {
  const { client, held } = buildClient(readBoard);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(buildWorkBoardKey(), BOARD);
  const undoStack = createUndoStack();
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const scrollRef = { current: document.createElement("div") };
  const view = renderHook(
    () => useCardMoves({ client, undoStack, serverBoard: BOARD, scrollRef }),
    {
      wrapper,
    },
  );
  takePlayedSprings();
  const stageOf = (id: string) =>
    view.result.current.board?.cards.find((card) => card.id === id)?.stage;
  return { ...view, held, queryClient, undoStack, stageOf };
};

/** Waits until `count` requests have been sent. A move is sent a moment after it is made. */
const waitForRequests = (held: readonly HeldMove[], count: number) =>
  waitFor(() => {
    expect(held).toHaveLength(count);
  });

describe("useCardMoves", () => {
  it("shows a move at once, and says what happened with an Undo", async () => {
    const { result, stageOf, held } = setUp();

    act(() => {
      result.current.moveCard({ taskId: "a", stage: "in-review" }, 'Moved "a" to In review');
    });

    expect(stageOf("a")).toBe("in-review");
    await waitForRequests(held, 1);
    expect(result.current.line).toMatchObject({
      text: 'Moved "a" to In review.',
      canUndo: true,
      isShown: true,
    });
  });

  it("sends moves one at a time, in the order they were made", async () => {
    const { result, held } = setUp();
    act(() => {
      result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
      result.current.moveCard({ taskId: "b", stage: "planned" }, "Moved b");
    });

    await waitForRequests(held, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(held.map((each) => each.taskId)).toEqual(["a"]);
    await act(() => {
      held[0]!.accept();
      return Promise.resolve();
    });
    await waitForRequests(held, 2);
    expect(held.map((each) => each.taskId)).toEqual(["a", "b"]);
  });

  it("puts the card back and says why when the controller refuses the move", async () => {
    const { result, stageOf, held, undoStack } = setUp();
    act(() => {
      result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
    });
    await waitForRequests(held, 1);

    await act(() => {
      held[0]!.refuse("the Task is gone.");
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(stageOf("a")).toBe("building");
    });
    expect(result.current.line.text).toBe(
      "The move did not save, so the card went back: the Task is gone. Try the move again.",
    );
    expect(result.current.line.canUndo).toBe(false);
    // The failed move left nothing for Undo to reverse.
    await waitFor(() => {
      expect(undoStack.peek()).toBeNull();
    });
  });

  it("does nothing for a move that changes nothing", () => {
    const { result, held } = setUp();

    act(() => {
      result.current.moveCard({ taskId: "a", stage: "building" }, "Moved a");
      result.current.moveCard({ taskId: "a", stage: "building", afterTaskId: null }, "Moved a");
    });

    expect(held).toHaveLength(0);
    expect(result.current.line.isShown).toBe(false);
  });

  it("waits for the move's own request before it undoes it, then moves the card back after its old neighbour", async () => {
    const { result, stageOf, held } = setUp();
    act(() => {
      result.current.moveCard({ taskId: "b", stage: "in-review", afterTaskId: "c" }, "Moved b");
    });

    act(() => {
      result.current.undoLastMove();
    });
    // The undo waits: only the move itself has been sent.
    await waitForRequests(held, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(held).toHaveLength(1);

    await act(() => {
      held[0]!.accept();
      return Promise.resolve();
    });
    await waitForRequests(held, 2);
    expect(held[1]).toMatchObject({
      taskId: "b",
      payload: { stage: "building", projectId: null, afterTaskId: "a" },
    });
    expect(stageOf("b")).toBe("building");

    await act(() => {
      held[1]!.accept();
      return Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.line.text).toBe("Put back: Moved b.");
    });
  });

  it("says nothing was put back when the move being undone did not save", async () => {
    const { result, held, undoStack } = setUp();
    act(() => {
      result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
      result.current.moveCard({ taskId: "b", stage: "planned" }, "Moved b");
    });
    await waitForRequests(held, 1);
    await act(() => {
      held[0]!.accept();
      return Promise.resolve();
    });
    await waitForRequests(held, 2);
    await act(() => {
      held[1]!.refuse("no");
      return Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.line.canUndo).toBe(false);
    });

    // The refused move left the stack; Undo reaches the move before it.
    expect(undoStack.peek()?.words).toBe("Moved a");
    expect(listIds(result.current.board!.cards)).toContain("b");
  });

  it("reads the board again after the last move finishes, and stops applying the move once it has", async () => {
    const reads = vi.fn(() => BOARD);
    const { result, held, stageOf } = setUp(reads);
    act(() => {
      result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
    });
    await waitForRequests(held, 1);

    await act(() => {
      held[0]!.accept();
      return Promise.resolve();
    });
    await waitFor(() => {
      expect(reads).toHaveBeenCalledTimes(1);
    });
    // The board the screen was given stands for that read, which holds no move.
    await waitFor(() => {
      expect(stageOf("a")).toBe("building");
    });
  });

  describe("motion", () => {
    it("plays a move by key and its undo on hand, and a plain move not at all", async () => {
      const { result, held } = setUp();

      act(() => {
        result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
      });
      expect(takePlayedSprings()).toEqual([]);

      act(() => {
        result.current.moveCardWithMotion({ taskId: "b", stage: "planned" }, "Moved b");
      });
      expect(takePlayedSprings()).toEqual(["hand"]);

      act(() => {
        result.current.undoLastMove();
      });
      await waitForRequests(held, 1);
      await act(() => {
        held[0]!.accept();
        return Promise.resolve();
      });
      await waitForRequests(held, 2);
      await act(() => {
        held[1]!.accept();
        return Promise.resolve();
      });
      await waitFor(() => {
        expect(takePlayedSprings()).toEqual(["hand"]);
      });
    });

    it("sends a card home on travel when the controller refuses its move", async () => {
      const { result, held } = setUp();
      act(() => {
        result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
      });
      await waitForRequests(held, 1);

      await act(() => {
        held[0]!.refuse("the Task is gone.");
        return Promise.resolve();
      });

      await waitFor(() => {
        expect(takePlayedSprings()).toEqual(["travel"]);
      });
    });
  });
});
