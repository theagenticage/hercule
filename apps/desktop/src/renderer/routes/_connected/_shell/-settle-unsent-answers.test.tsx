/** Tests that a lookup of an unsent answer's Task that failed is tried again after the next board read. */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HerculeClient } from "@hercule/client-core";
import { buildCard } from "@hercule/client-core/work/testing";
import {
  createPendingIntents,
  UNDO_WINDOW_MS,
  listUnsentAnswers,
} from "../../../app/pending-intents";
import { useSettleUnsentAnswers } from "./-settle-unsent-answers";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("settling the unsent answers of a Task the board does not show", () => {
  it("looks the Task up again after a board read when the first lookup got no answer, and then stops", async () => {
    const store = createPendingIntents({
      storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      storageKey: "key",
      send: () => Promise.reject(new Error("The runner is away.")),
    });
    store.hold({
      kind: "answer",
      taskId: "task-s",
      sessionId: "session-1",
      requestId: "request-1",
      answers: { "Which store?": "Northwind Market" },
    });
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    // The connection is lost for the first lookup, and back for the second.
    const readDetail = vi
      .fn()
      .mockRejectedValueOnce(new Error("cannot reach http://127.0.0.1:4937"))
      .mockResolvedValue({ task: { id: "task-t" } });
    const client = { task: { readDetail } } as unknown as HerculeClient;
    const props = (boardReadAt: number) => ({
      client,
      store,
      intents: store.getSnapshot(),
      // The survivor is on the board, the merged Task is not.
      boardCards: [buildCard("task-t")],
      isBoardRead: true,
      boardReadAt,
    });

    const { rerender } = renderHook(
      (boardReadAt: number) => {
        useSettleUnsentAnswers(props(boardReadAt));
      },
      { initialProps: 1 },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(readDetail).toHaveBeenCalledTimes(1);
    expect(listUnsentAnswers(store.getSnapshot(), "task-s")).toHaveLength(1);

    rerender(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(readDetail).toHaveBeenCalledTimes(2);
    expect(listUnsentAnswers(store.getSnapshot(), "task-t")).toHaveLength(1);

    // Every lookup was answered, so another board read starts none.
    rerender(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(readDetail).toHaveBeenCalledTimes(2);
  });
});
