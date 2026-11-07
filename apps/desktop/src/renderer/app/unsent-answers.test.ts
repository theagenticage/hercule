/** Tests that unsent answers follow their Task to the Task it was merged into, and go when it is gone. */
import { ApiError, type HerculeClient } from "@hercule/client-core";
import type { TaskDetail } from "@hercule/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPendingIntents,
  UNDO_WINDOW_MS,
  listUnsentAnswers,
  type PendingIntents,
} from "./pending-intents";
import { settleUnsentAnswers } from "./unsent-answers";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Holds one answer on `taskId` and lets it fail, so the store has an unsent answer. */
const storeWithUnsentAnswer = async (taskId: string): Promise<PendingIntents> => {
  const store = createPendingIntents({
    storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    storageKey: "key",
    send: () => Promise.reject(new Error("The runner is away.")),
  });
  store.hold({
    kind: "answer",
    taskId,
    sessionId: "session-1",
    requestId: "request-1",
    answers: { "Which store?": "Northwind Market" },
  });
  await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
  return store;
};

/** A client whose `task.readDetail` does `read`. */
const buildClient = (read: () => Promise<unknown>): HerculeClient =>
  ({ task: { readDetail: vi.fn(read) } }) as unknown as HerculeClient;

describe("settling the unsent answers of a Task", () => {
  it("shows them on the Task it was merged into, which the read answers with", async () => {
    const store = await storeWithUnsentAnswer("task-s");
    const client = buildClient(() => Promise.resolve({ task: { id: "task-t" } } as TaskDetail));

    await settleUnsentAnswers(client, store, ["task-s"]);

    expect(listUnsentAnswers(store.getSnapshot(), "task-s")).toEqual([]);
    expect(listUnsentAnswers(store.getSnapshot(), "task-t")).toMatchObject([
      { sessionId: "session-1", requestId: "request-1" },
    ]);
  });

  it("discards them when the read says the Task is deleted", async () => {
    const store = await storeWithUnsentAnswer("task-s");
    const client = buildClient(() => Promise.reject(new ApiError("not_found", "No.")));

    const isSettled = await settleUnsentAnswers(client, store, ["task-s"]);

    expect(isSettled).toBe(true);
    expect(store.getSnapshot()).toEqual([]);
  });

  it("keeps them when the Task is finished, because it can be moved back and its question may be open", async () => {
    const store = await storeWithUnsentAnswer("task-s");
    const client = buildClient(() => Promise.reject(new ApiError("invalid_state", "Finished.")));

    const isSettled = await settleUnsentAnswers(client, store, ["task-s"]);

    expect(isSettled).toBe(true);
    expect(listUnsentAnswers(store.getSnapshot(), "task-s")).toHaveLength(1);
  });

  it("keeps them when the Task is as it was, and when the read fails some other way", async () => {
    const store = await storeWithUnsentAnswer("task-s");

    await settleUnsentAnswers(
      buildClient(() => Promise.resolve({ task: { id: "task-s" } })),
      store,
      ["task-s"],
    );
    const isSettled = await settleUnsentAnswers(
      buildClient(() => Promise.reject(new Error("cannot reach http://127.0.0.1:4937"))),
      store,
      ["task-s"],
    );

    expect(isSettled).toBe(false);
    expect(listUnsentAnswers(store.getSnapshot(), "task-s")).toHaveLength(1);
  });
});
