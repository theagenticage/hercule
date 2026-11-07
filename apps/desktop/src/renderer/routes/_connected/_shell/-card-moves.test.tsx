/**
 * Tests moving cards through `useCardMoves`: a move shows at once and is sent
 * in order, a read that lands meanwhile cannot undo it, an answered move is
 * written into the cached board, a failed move goes back and says why, and
 * Undo takes its place in the queue the moment it is pressed and puts the
 * card back where it stood. What the cards do on screen needs a real layout,
 * so these tests only check which spring a change is played on.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { notifyManager, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { invalidateWithoutCancelling, queryKeys, type HerculeClient } from "@hercule/client-core";
import { buildBoard, buildCard, listIds } from "@hercule/client-core/work/testing";
import type { WorkBoard } from "@hercule/contract";
import { flipByKey } from "../../../app/motion";
import type { CardMover } from "../../../app/card-mover";
import { createUndoStack } from "../../../app/undo-stack";
import { useCardMoves } from "./-card-moves";
import { workBoardQuery } from "./-work-board";

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
const buildClient = (readBoard: () => WorkBoard | Promise<WorkBoard>) => {
  const held: HeldMove[] = [];
  const client = {
    task: {
      queryBoard: () => Promise.resolve().then(readBoard),
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

/** A read the test answers when it chooses. */
interface HeldRead {
  readonly resolve: (board: WorkBoard) => void;
  readonly reject: () => void;
}

/** Returns a `readBoard` for `setUp` whose every read waits for the test, and the reads so far, oldest first. */
const holdReads = () => {
  const reads: HeldRead[] = [];
  const readBoard = () =>
    new Promise<WorkBoard>((resolve, reject) => {
      reads.push({
        resolve,
        reject: () => {
          reject(new Error("offline"));
        },
      });
    });
  return { reads, readBoard };
};

const setUp = (readBoard: () => WorkBoard | Promise<WorkBoard> = () => BOARD) => {
  const { client, held } = buildClient(readBoard);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.workBoard(), BOARD);
  const undoStack = createUndoStack<CardMover>();
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  /** Mounts the hook as the Work screen does, with the board in the query cache. */
  const mount = () => {
    const scrollRef = { current: document.createElement("div") };
    const view = renderHook(
      () => {
        const { data } = useQuery(workBoardQuery(client));
        return useCardMoves({ client, undoStack, serverBoard: data, scrollRef });
      },
      { wrapper },
    );
    takePlayedSprings();
    return view;
  };
  const view = mount();
  const findStage = (id: string, board = view.result.current.board) =>
    board?.cards.find((card) => card.id === id)?.stage;
  return { ...view, held, client, queryClient, undoStack, findStage, mount };
};

/** Waits until `count` requests have been sent. A move is sent a moment after it is made. */
const waitForRequests = (held: readonly HeldMove[], count: number) =>
  waitFor(() => {
    expect(held).toHaveLength(count);
  });

/** Lets the promises of the queued requests and the reads that follow them run. */
const settleQueue = async (): Promise<void> => {
  for (let turn = 0; turn < 80; turn++) await Promise.resolve();
};

/** Lets the timer pass that delivers a changed query to the screen. */
const settleNews = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 20));

describe("useCardMoves", () => {
  it("shows a move at once, and says what happened with an Undo", async () => {
    const { result, findStage, held } = setUp();

    act(() => {
      result.current.moveCard({ taskId: "a", stage: "in-review" }, 'Moved "a" to In review');
    });

    expect(findStage("a")).toBe("in-review");
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
    const { result, findStage, held } = setUp();
    act(() => {
      result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
    });
    await waitForRequests(held, 1);

    await act(() => {
      held[0]!.refuse("the Task is gone.");
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(findStage("a")).toBe("building");
    });
    expect(result.current.line.text).toBe(
      "The move did not save, so the card went back: the Task is gone. Try the move again.",
    );
    expect(result.current.line.canUndo).toBe(false);
    // The failed move left nothing for Undo to reverse.
    act(() => {
      result.current.undoLastMove();
    });
    await waitFor(() => {
      expect(result.current.line.text).toBe("Nothing to undo.");
    });
  });

  it("adds the note to the line after the words, with Undo kept", () => {
    const { result } = setUp();

    act(() => {
      result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a", "A note.");
    });

    expect(result.current.line).toMatchObject({
      text: "Moved a. A note.",
      canUndo: true,
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

  it("puts the card back at once after its move, queued right behind it", async () => {
    const { result, findStage, held } = setUp();
    act(() => {
      result.current.moveCard({ taskId: "b", stage: "in-review", afterTaskId: "c" }, "Moved b");
    });

    act(() => {
      result.current.undoLastMove();
    });
    // The card is back on screen at once, though only the move itself can be sent so far.
    expect(findStage("b")).toBe("building");
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

    await act(() => {
      held[1]!.accept();
      return Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.line.text).toBe("Put back: Moved b.");
    });
  });

  it("sends a later move after the undo that was pressed before it", async () => {
    const { result, held } = setUp();
    act(() => {
      result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
    });
    act(() => {
      result.current.undoLastMove();
    });
    act(() => {
      result.current.moveCard({ taskId: "a", stage: "planned" }, "Moved a again");
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
    await waitForRequests(held, 3);
    // The last request is the newest gesture, so the card ends in Planned.
    expect(held.map((each) => (each.payload as { stage: string }).stage)).toEqual([
      "in-review",
      "building",
      "planned",
    ]);
  });

  it("puts the card back through the Work screen that is open now, after a visit elsewhere", async () => {
    const { result, held, mount, findStage, queryClient, unmount } = setUp();
    act(() => {
      result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
    });
    await waitForRequests(held, 1);
    await act(() => {
      held[0]!.accept();
      return Promise.resolve();
    });
    unmount();

    // The Work screen opens again and reads the board with the move in it.
    const movedBoard = buildBoard(
      buildCard("a", { stage: "in-review" }),
      buildCard("b", { stage: "building" }),
      buildCard("c", { stage: "in-review" }),
    );
    queryClient.setQueryData(queryKeys.workBoard(), movedBoard);
    const again = mount();
    expect(findStage("a", again.result.current.board)).toBe("in-review");
    act(() => {
      again.result.current.undoLastMove();
    });

    expect(findStage("a", again.result.current.board)).toBe("building");
    await waitForRequests(held, 2);
  });

  it("sends no undo when the move being undone was refused", async () => {
    const { result, held, findStage } = setUp();
    act(() => {
      result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
    });
    act(() => {
      result.current.undoLastMove();
    });
    await waitForRequests(held, 1);

    await act(async () => {
      held[0]!.refuse("the Task is gone.");
      await settleQueue();
    });

    // The card never left its place, so the undo has nothing to write.
    expect(held).toHaveLength(1);
    await waitFor(() => {
      expect(result.current.line.text).toMatch(
        /^Could not put back: Moved a\. That move did not save/,
      );
    });
    expect(findStage("a")).toBe("building");
  });

  it("sends no undo when the move being undone was refused over another client's move", async () => {
    const { result, held, queryClient } = setUp();
    act(() => {
      result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
    });
    await waitForRequests(held, 1);
    act(() => {
      // Another client moved the card to Landed. Undo is pressed before the refusal arrives.
      queryClient.setQueryData(
        queryKeys.workBoard(),
        buildBoard(
          buildCard("a", { stage: "landed" }),
          buildCard("b", { stage: "building" }),
          buildCard("c", { stage: "in-review" }),
        ),
      );
      result.current.undoLastMove();
    });

    await act(async () => {
      held[0]!.refuse("afterTaskId is no longer in this cell");
      await settleQueue();
    });

    // Sending the undo would drag the card from Landed back to Building.
    expect(held).toHaveLength(1);
    await waitFor(() => {
      expect(result.current.line.text).toMatch(
        /^Could not put back: Moved a\. That move did not save/,
      );
    });
  });

  it("says nothing was put back when the move being undone did not save", async () => {
    const { result, held } = setUp();
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

    // The refused move left the stack, so Undo reaches the move before it.
    act(() => {
      result.current.undoLastMove();
    });
    await waitForRequests(held, 3);
    expect(held[2]).toMatchObject({ taskId: "a", payload: { stage: "building" } });
    expect(listIds(result.current.board!.cards)).toContain("b");
  });

  it("leaves a refused move off the stack even when a saved move was made after it", async () => {
    const { result, held } = setUp();
    act(() => {
      result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
      result.current.moveCard({ taskId: "b", stage: "planned" }, "Moved b");
    });
    await waitForRequests(held, 1);
    await act(() => {
      held[0]!.refuse("no");
      return Promise.resolve();
    });
    await waitForRequests(held, 2);
    await act(() => {
      held[1]!.accept();
      return Promise.resolve();
    });

    act(() => {
      result.current.undoLastMove();
    });
    await waitForRequests(held, 3);
    await act(() => {
      held[2]!.accept();
      return Promise.resolve();
    });
    // The newest gesture is b, which saved. a is not left on the stack to say it did not save.
    await waitFor(() => {
      expect(result.current.line.text).toBe("Put back: Moved b.");
    });
    act(() => {
      result.current.undoLastMove();
    });
    await waitFor(() => {
      expect(result.current.line.text).toBe("Nothing to undo.");
    });
  });

  describe("when the controller answers", () => {
    /** Moves a to In review and b to Planned, and returns once the move of a is sent. */
    const moveAThenB = async (setup: ReturnType<typeof setUp>) => {
      act(() => {
        setup.result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
        setup.result.current.moveCard({ taskId: "b", stage: "planned" }, "Moved b");
      });
      await waitForRequests(setup.held, 1);
    };

    const BOARD_WITH_A_MOVED = buildBoard(
      buildCard("a", { stage: "in-review" }),
      buildCard("b", { stage: "building" }),
      buildCard("c", { stage: "in-review" }),
    );

    it("keeps a later pending move drawn when a read that started after the answer lands", async () => {
      const { readBoard, reads } = holdReads();
      const setup = setUp(readBoard);
      const { held, findStage, queryClient } = setup;
      await moveAThenB(setup);
      // A push starts a read, which is still running when the controller answers.
      act(() => {
        invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
      });
      await waitFor(() => {
        expect(reads).toHaveLength(1);
      });

      await act(async () => {
        held[0]!.accept();
        await settleQueue();
      });
      // The answer cancelled that read, so the push starts another one.
      await waitFor(() => {
        expect(reads).toHaveLength(2);
      });
      await act(async () => {
        reads[1]!.resolve(BOARD_WITH_A_MOVED);
        await settleQueue();
        await settleNews();
      });

      expect(findStage("a")).toBe("in-review");
      expect(findStage("b")).toBe("planned");
    });

    it("shows the answered move when a read that ended before the answer left it out", async () => {
      const { readBoard, reads } = holdReads();
      const setup = setUp(readBoard);
      const { held, findStage, queryClient } = setup;
      act(() => {
        setup.result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
      });
      await waitForRequests(held, 1);
      act(() => {
        invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
      });
      await waitFor(() => {
        expect(reads).toHaveLength(1);
      });
      await act(async () => {
        reads[0]!.resolve(BOARD);
        await settleQueue();
        await settleNews();
      });
      expect(findStage("a")).toBe("in-review");

      await act(async () => {
        held[0]!.accept();
        await settleQueue();
      });

      expect(findStage("a")).toBe("in-review");
    });

    it("cancels a read that started before the answer, so it never publishes", async () => {
      const { readBoard, reads } = holdReads();
      const setup = setUp(readBoard);
      const { held, findStage, queryClient } = setup;
      act(() => {
        setup.result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
      });
      await waitForRequests(held, 1);
      act(() => {
        invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
      });
      await waitFor(() => {
        expect(reads).toHaveLength(1);
      });

      await act(async () => {
        held[0]!.accept();
        await settleQueue();
      });
      // The controller had not saved the move when this read began, so it holds the old board.
      await act(async () => {
        reads[0]!.resolve(BOARD);
        await settleQueue();
        await settleNews();
      });

      expect(findStage("a")).toBe("in-review");
    });

    it("reads the board again after the last move, and shows what that read holds", async () => {
      const { readBoard, reads } = holdReads();
      const setup = setUp(readBoard);
      const { held, findStage, result } = setup;
      act(() => {
        result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
      });
      await waitForRequests(held, 1);

      await act(async () => {
        held[0]!.accept();
        await settleQueue();
      });
      await waitFor(() => {
        expect(reads).toHaveLength(1);
      });
      await act(async () => {
        reads[0]!.resolve(
          buildBoard(
            buildCard("a", { stage: "landed" }),
            buildCard("b", { stage: "building" }),
            buildCard("c", { stage: "in-review" }),
          ),
        );
        await settleQueue();
      });

      await waitFor(() => {
        expect(findStage("a")).toBe("landed");
      });
    });

    it("does not make the next move wait for the read after the last one", async () => {
      const { readBoard, reads } = holdReads();
      const setup = setUp(readBoard);
      const { held, result } = setup;
      act(() => {
        result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
      });
      await waitForRequests(held, 1);
      await act(async () => {
        held[0]!.accept();
        await settleQueue();
      });
      await waitFor(() => {
        expect(reads).toHaveLength(1);
      });

      act(() => {
        result.current.moveCard({ taskId: "b", stage: "planned" }, "Moved b");
      });

      // The read is still running, and the move is already sent.
      await waitForRequests(held, 2);
    });

    it("shows another client's move of the card when a read after a failed read succeeds", async () => {
      const { readBoard, reads } = holdReads();
      const setup = setUp(readBoard);
      const { held, findStage, queryClient } = setup;
      act(() => {
        setup.result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
      });
      await waitForRequests(held, 1);
      await act(async () => {
        held[0]!.accept();
        await settleQueue();
      });
      await waitFor(() => {
        expect(reads).toHaveLength(1);
      });
      // The read after the last move fails, so the screen keeps the answered move.
      await act(async () => {
        reads[0]!.reject();
        await settleQueue();
      });
      expect(findStage("a")).toBe("in-review");

      // The connection comes back, and another client has moved the card on.
      act(() => {
        invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
      });
      await waitFor(() => {
        expect(reads).toHaveLength(2);
      });
      await act(async () => {
        reads[1]!.resolve(
          buildBoard(
            buildCard("a", { stage: "landed" }),
            buildCard("b", { stage: "building" }),
            buildCard("c", { stage: "in-review" }),
          ),
        );
        await settleQueue();
      });

      await waitFor(() => {
        expect(findStage("a")).toBe("landed");
      });
    });

    it("keeps a move that is pending when an older read's news arrives late", async () => {
      const { readBoard, reads } = holdReads();
      const { result, held, findStage, queryClient } = setUp(readBoard);
      // Hold back the news of reads, as the default scheduler does with a timer.
      const delayed: (() => void)[] = [];
      notifyManager.setScheduler((callback) => {
        delayed.push(callback);
      });
      try {
        // This read ends before the move below is made.
        act(() => {
          invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
        });
        await waitFor(() => {
          expect(reads).toHaveLength(1);
        });
        await act(async () => {
          reads[0]!.resolve(BOARD);
          await settleQueue();
        });
        act(() => {
          result.current.moveCard({ taskId: "a", stage: "in-review" }, "Moved a");
        });
        await waitForRequests(held, 1);
        await act(async () => {
          held[0]!.accept();
          await settleQueue();
        });
        await waitFor(() => {
          expect(reads).toHaveLength(2);
        });
        await act(async () => {
          reads[1]!.reject();
          await settleQueue();
        });
        expect(findStage("a")).toBe("in-review");

        // The news of the older read arrives now. It predates the move, so it cannot undo it.
        await act(async () => {
          while (delayed.length > 0) delayed.shift()!();
          await settleQueue();
        });

        expect(findStage("a")).toBe("in-review");
      } finally {
        notifyManager.setScheduler((callback) => setTimeout(callback, 0));
      }
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
