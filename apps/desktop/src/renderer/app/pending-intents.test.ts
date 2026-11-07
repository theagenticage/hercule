/** Tests the store of intents held for the undo line: answers and merges. */
import { ApiError } from "@hercule/client-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPendingIntentsKey,
  createPendingIntents,
  findHeldAnswer,
  listFailedMerges,
  listHeldAnswers,
  listHeldMerges,
  listUnsentAnswers,
  UNDO_WINDOW_MS,
  type IntentContent,
  type IntentStorage,
  type PendingIntents,
} from "./pending-intents";

/** The details the controller puts on a refusal that means the Request is closed. */
const CLOSED = { reason: "request-closed" };

const KEY = buildPendingIntentsKey("http://127.0.0.1:4937", "user-1");

const ANSWER: IntentContent = {
  kind: "answer",
  taskId: "task-1",
  sessionId: "session-1",
  requestId: "request-1",
  answers: { "Which store?": "Northwind Market" },
};
const MERGE: IntentContent = { kind: "merge", taskId: "task-2", intoTaskId: "task-1" };

/** The two kinds, since they follow the same rules. */
const KINDS: ReadonlyArray<readonly [string, IntentContent]> = [
  ["answer", ANSWER],
  ["merge", MERGE],
];

const createMemoryStorage = (): IntentStorage => {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
};

/** A send whose outcome the test decides, one call at a time. */
const createSend = () => {
  const calls: Array<{
    intent: IntentContent;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  const send = vi.fn(
    (intent: IntentContent) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ intent, resolve, reject });
      }),
  );
  return { send, calls };
};

const open = (storage: IntentStorage, send: (intent: IntentContent) => Promise<unknown>) =>
  createPendingIntents({ storage, storageKey: KEY, send });

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe.each(KINDS)("a held %s", (_kind, content) => {
  let storage: IntentStorage;
  let stub: ReturnType<typeof createSend>;
  let intents: PendingIntents;
  beforeEach(() => {
    storage = createMemoryStorage();
    stub = createSend();
    intents = open(storage, stub.send);
  });

  it("is sent after the undo window and leaves when the send succeeds", async () => {
    const intentId = intents.hold(content);
    expect(intents.getSnapshot()).toMatchObject([{ intentId, state: "pending" }]);

    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS - 1);
    expect(stub.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stub.send).toHaveBeenCalledWith(expect.objectContaining(content));
    expect(intents.getSnapshot()).toMatchObject([{ state: "sending" }]);

    stub.calls[0]?.resolve();
    await settle();
    expect(intents.getSnapshot()).toEqual([]);
    expect(storage.getItem(KEY)).toBeNull();
  });

  it("is cancelled by Undo while pending, and never sent", async () => {
    const intentId = intents.hold(content);
    expect(intents.undo(intentId)).toBe(true);
    expect(intents.getSnapshot()).toEqual([]);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);
    expect(stub.send).not.toHaveBeenCalled();
  });

  it("is not cancelled by Undo once sending", async () => {
    const intentId = intents.hold(content);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(intents.undo(intentId)).toBe(false);
    expect(intents.getSnapshot()).toMatchObject([{ state: "sending" }]);
  });

  it("fails with the error's words when refused, then retries at once and is discardable", async () => {
    const intentId = intents.hold(content);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    stub.calls[0]?.reject(new Error("The runner is offline."));
    await settle();
    expect(intents.getSnapshot()).toMatchObject([
      { state: "failed", failure: { reason: "send-failed", message: "The runner is offline." } },
    ]);
    expect(intents.getSnapshot()[0]).toMatchObject(content);
    expect(JSON.parse(storage.getItem(KEY) ?? "[]")).toHaveLength(1);

    const retried = intents.retry(intentId);
    expect(stub.send).toHaveBeenCalledTimes(2);
    expect(intents.getSnapshot()).toMatchObject([{ state: "sending", failure: null }]);
    stub.calls[1]?.reject(new Error("Still offline."));
    await retried;
    expect(intents.getSnapshot()).toMatchObject([
      { state: "failed", failure: { message: "Still offline." } },
    ]);

    intents.discard(intentId);
    expect(intents.getSnapshot()).toEqual([]);
    expect(storage.getItem(KEY)).toBeNull();
  });

  it("comes back failed after a restart, keeps its content, and sends nothing", async () => {
    const pendingId = intents.hold(content);
    const sendingId = intents.hold(content);
    intents.undo(sendingId);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    intents.hold(content);
    intents.dispose();

    const send = vi.fn(() => Promise.resolve());
    const reopened = open(storage, send);
    expect(reopened.getSnapshot()).toHaveLength(2);
    expect(reopened.getSnapshot()).toMatchObject([
      { intentId: pendingId, state: "failed", failure: { reason: "interrupted" }, ...content },
      { state: "failed", failure: { reason: "interrupted" }, ...content },
    ]);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 3);
    expect(send).not.toHaveBeenCalled();
  });

  it("does nothing when a send ends after dispose, and leaves a newer store's storage alone", async () => {
    intents.hold(content);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    intents.dispose();

    const newer = open(storage, createSend().send);
    const stored = storage.getItem(KEY);
    stub.calls[0]?.resolve();
    await settle();
    expect(storage.getItem(KEY)).toBe(stored);
    expect(newer.getSnapshot()).toHaveLength(1);
  });
});

describe("the store", () => {
  it.each([
    ["the session is gone", new ApiError("not_found", "no such session"), "no-longer-open"],
    [
      "the session has no open Request",
      new ApiError("invalid_state", "that session is not waiting on a request", CLOSED),
      "no-longer-open",
    ],
    [
      "the session exited",
      new ApiError("invalid_state", "that session has exited", CLOSED),
      "no-longer-open",
    ],
    [
      "the runner is away",
      new ApiError("invalid_state", "that session's runner is no longer connected"),
      "send-failed",
    ],
    [
      "an answer is already on its way",
      new ApiError("invalid_state", "an answer to this question is already on its way; wait"),
      "send-failed",
    ],
    [
      "the runner did not confirm",
      new ApiError("invalid_state", "that session's runner did not confirm the answer in time"),
      "send-failed",
    ],
  ])("on a refused retry because %s, the answer is %s", async (_why, error, reason) => {
    const stub = createSend();
    const intents = open(createMemoryStorage(), stub.send);
    const intentId = intents.hold(ANSWER);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    stub.calls[0]?.reject(new Error("lost"));
    await settle();
    const retried = intents.retry(intentId);
    stub.calls[1]?.reject(error);
    await retried;
    expect(intents.getSnapshot()[0]?.failure?.reason).toBe(reason);
  });

  it("sends the answers as they were at the pick, not as the caller changed them later", async () => {
    const stub = createSend();
    const intents = open(createMemoryStorage(), stub.send);
    const answers = { "Which store?": "Northwind Market" };
    intents.hold({ ...ANSWER, answers });
    answers["Which store?"] = "Contoso";
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(stub.calls[0]?.intent).toMatchObject({
      answers: { "Which store?": "Northwind Market" },
    });
  });

  it("holds and sends nothing after dispose, through hold or retry", async () => {
    const storage = createMemoryStorage();
    const stub = createSend();
    const intents = open(storage, stub.send);
    const intentId = intents.hold(ANSWER);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    stub.calls[0]?.reject(new Error("No."));
    await settle();
    intents.dispose();
    const stored = storage.getItem(KEY);

    await intents.retry(intentId);
    intents.hold(MERGE);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);
    expect(stub.send).toHaveBeenCalledTimes(1);
    expect(storage.getItem(KEY)).toBe(stored);
  });

  it("still holds and sends when storage refuses a write", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storage: IntentStorage = {
      ...createMemoryStorage(),
      setItem: () => {
        throw new Error("The quota is full.");
      },
    };
    const stub = createSend();
    const intents = open(storage, stub.send);
    const intentId = intents.hold(MERGE);
    expect(intents.getSnapshot()).toMatchObject([{ intentId, state: "pending" }]);

    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(stub.send).toHaveBeenCalledTimes(1);
    stub.calls[0]?.resolve();
    await settle();
    expect(intents.getSnapshot()).toEqual([]);
    error.mockRestore();
  });

  it("shows another controller or user nothing", () => {
    const storage = createMemoryStorage();
    const { send } = createSend();
    open(storage, send).hold(ANSWER);

    const read = (key: string) =>
      createPendingIntents({ storage, storageKey: key, send }).getSnapshot();
    expect(read(KEY)).toHaveLength(1);
    expect(read(buildPendingIntentsKey("http://10.0.0.2:4937", "user-1"))).toEqual([]);
    expect(read(buildPendingIntentsKey("http://127.0.0.1:4937", "user-2"))).toEqual([]);
  });

  it("ignores stored text it cannot read", () => {
    const storage = createMemoryStorage();
    storage.setItem(KEY, "{not json");
    expect(open(storage, createSend().send).getSnapshot()).toEqual([]);
    storage.setItem(KEY, JSON.stringify([{ intentId: "x", kind: "answer" }, 7]));
    expect(open(storage, createSend().send).getSnapshot()).toEqual([]);
  });

  it("explains a refused retry of an answer as no longer open, and never sends it elsewhere", async () => {
    const storage = createMemoryStorage();
    const stub = createSend();
    const intents = open(storage, stub.send);
    const intentId = intents.hold(ANSWER);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    // The response is lost, so the app sees a network failure.
    stub.calls[0]?.reject(new Error("cannot reach http://127.0.0.1:4937"));
    await settle();

    const retried = intents.retry(intentId);
    stub.calls[1]?.reject(
      new ApiError(
        "invalid_state",
        "that request is not one this session is waiting on; read the session again to see the requests it waits on now",
        CLOSED,
      ),
    );
    await retried;

    expect(intents.getSnapshot()).toMatchObject([
      {
        state: "failed",
        failure: { reason: "no-longer-open" },
        ...ANSWER,
      },
    ]);
    expect(stub.send).toHaveBeenCalledTimes(2);
    expect(stub.calls.every((call) => call.intent.kind === "answer")).toBe(true);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 3);
    expect(stub.send).toHaveBeenCalledTimes(2);
  });

  it("says a first send refused because the Request closed took nothing, and offers no Send again", async () => {
    const stub = createSend();
    const intents = open(createMemoryStorage(), stub.send);
    intents.hold(ANSWER);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    stub.calls[0]?.reject(new ApiError("invalid_state", "Closed.", CLOSED));
    await settle();

    expect(intents.getSnapshot()).toMatchObject([
      { state: "failed", failure: { reason: "closed-before-sent" } },
    ]);
  });

  it("calls a refused merge a failed send even when the refusal says a Request closed, and an unrelated refusal of an answer too", async () => {
    const stub = createSend();
    const intents = open(createMemoryStorage(), stub.send);
    intents.hold(ANSWER);
    const mergeId = intents.hold(MERGE);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    stub.calls[0]?.reject(new ApiError("invalid_state", "The runner is away."));
    stub.calls[1]?.reject(new ApiError("invalid_state", "Closed.", CLOSED));
    await settle();
    expect(intents.getSnapshot().map((intent) => intent.failure?.reason)).toEqual([
      "send-failed",
      "send-failed",
    ]);

    const retried = intents.retry(mergeId);
    stub.calls[2]?.reject(new ApiError("invalid_state", "Closed.", CLOSED));
    await retried;
    expect(
      intents.getSnapshot().find((intent) => intent.intentId === mergeId)?.failure?.reason,
    ).toBe("send-failed");
  });

  it("finds a held answer by session and Request, and lists the held answers and merges", async () => {
    const stub = createSend();
    const intents = open(createMemoryStorage(), stub.send);
    intents.hold(ANSWER);
    intents.hold(MERGE);
    const snapshot = () => intents.getSnapshot();

    expect(findHeldAnswer(snapshot(), "session-1", "request-1")).toMatchObject(ANSWER);
    expect(findHeldAnswer(snapshot(), "session-1", "request-2")).toBeUndefined();
    expect(listHeldAnswers(snapshot())).toMatchObject([ANSWER]);
    expect(listHeldMerges(snapshot())).toMatchObject([MERGE]);
    expect(listFailedMerges(snapshot())).toEqual([]);

    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(findHeldAnswer(snapshot(), "session-1", "request-1")).toBeDefined();
    stub.calls.forEach((call) => call.reject(new Error("No.")));
    await settle();
    expect(findHeldAnswer(snapshot(), "session-1", "request-1")).toBeUndefined();
    expect(listHeldAnswers(snapshot())).toEqual([]);
    expect(listHeldMerges(snapshot())).toEqual([]);
    expect(listFailedMerges(snapshot())).toMatchObject([MERGE]);
  });

  it("tells subscribers about each change, and hands out one snapshot between changes", () => {
    const intents = open(createMemoryStorage(), createSend().send);
    const listener = vi.fn();
    const unsubscribe = intents.subscribe(listener);
    const before = intents.getSnapshot();
    expect(intents.getSnapshot()).toBe(before);

    const intentId = intents.hold(MERGE);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(intents.getSnapshot()).not.toBe(before);

    unsubscribe();
    intents.undo(intentId);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("the unsent answers of a Task", () => {
  it("lists the failed answers of that Task only", async () => {
    vi.useFakeTimers();
    const stub = createSend();
    const intents = open(createMemoryStorage(), stub.send);
    intents.hold(ANSWER);
    intents.hold({ ...ANSWER, taskId: "task-9", requestId: "request-9" });
    intents.hold(MERGE);
    expect(listUnsentAnswers(intents.getSnapshot(), "task-1")).toEqual([]);

    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    stub.calls.forEach((call) => call.reject(new Error("No.")));
    await settle();

    expect(listUnsentAnswers(intents.getSnapshot(), "task-1")).toMatchObject([
      { ...ANSWER, state: "failed", failure: { reason: "send-failed", message: "No." } },
    ]);
  });
});

describe("showing unsent answers on another Task", () => {
  it("moves the failed answers of a Task to the one it was merged into, and keeps where they are sent", async () => {
    vi.useFakeTimers();
    const stub = createSend();
    const intents = open(createMemoryStorage(), stub.send);
    intents.hold(ANSWER);
    const held = intents.hold({ ...ANSWER, requestId: "request-2" });
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    stub.calls[0]?.reject(new Error("No."));
    await settle();
    // The second answer is still being sent, so it does not move.
    intents.moveFailedAnswers("task-1", "task-9");

    expect(listUnsentAnswers(intents.getSnapshot(), "task-1")).toEqual([]);
    expect(listUnsentAnswers(intents.getSnapshot(), "task-9")).toMatchObject([
      { sessionId: "session-1", requestId: "request-1" },
    ]);
    expect(intents.getSnapshot().find((intent) => intent.intentId === held)).toMatchObject({
      taskId: "task-1",
      state: "sending",
    });
  });

  it("tells subscribers nothing when there is nothing to move", () => {
    const intents = open(createMemoryStorage(), createSend().send);
    const listener = vi.fn();
    intents.subscribe(listener);
    intents.moveFailedAnswers("task-1", "task-9");
    expect(listener).not.toHaveBeenCalled();
  });
});
