/**
 * Tests the account scope: what sign-out closes, that a new user starts with
 * nothing in memory, and that what was unsent stays in storage.
 */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HerculeClient } from "@hercule/client-core";
import { createAccountScopes } from "./account-scope";
import { UNDO_WINDOW_MS, type IntentContent, type IntentStorage } from "./pending-intents";

const URL = "http://127.0.0.1:4937";

const ANSWER: IntentContent = {
  kind: "answer",
  taskId: "task-1",
  sessionId: "session-1",
  requestId: "request-1",
  answers: { "Which store?": "Northwind Market" },
};

const createMemoryStorage = (): IntentStorage => {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
};

const setUp = () => {
  let token: string | null = "token-1";
  const respondToQuestion = vi.fn(() => Promise.resolve({}));
  const client = {
    getToken: () => token,
    session: { respondToQuestion },
  } as unknown as HerculeClient;
  const storage = createMemoryStorage();
  const scopes = createAccountScopes({
    controllerUrl: URL,
    client,
    queryClient: new QueryClient(),
    storage,
  });
  return {
    scopes,
    storage,
    respondToQuestion,
    signOut: () => {
      token = null;
    },
  };
};

describe("the account scope", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands out one scope per user, and closes the first user's when another user opens one", () => {
    const { scopes } = setUp();

    const first = scopes.open("ada");
    expect(scopes.open("ada")).toBe(first);
    const other = scopes.open("bob");

    expect(other).not.toBe(first);
    expect(first.isCurrent()).toBe(false);
    expect(other.isCurrent()).toBe(true);
  });

  it("is current until it is closed, and not current after", () => {
    const { scopes } = setUp();
    const scope = scopes.open("ada");
    expect(scope.isCurrent()).toBe(true);

    scopes.close();

    expect(scope.isCurrent()).toBe(false);
  });

  it("is not current once the client holds another token, before the scope is closed", () => {
    const { scopes, signOut } = setUp();
    const scope = scopes.open("ada");

    signOut();

    expect(scope.isCurrent()).toBe(false);
  });

  it("empties the undo stack and the pending moves, and sends no held intent, when it closes", async () => {
    const { scopes, respondToQuestion } = setUp();
    const scope = scopes.open("ada");
    const moved = { words: "Moved a", undo: () => Promise.resolve(undefined) };
    scope.undoStack.reserve(moved, Promise.resolve(true));
    scope.pendingCardMoves.add({
      change: { kind: "move", move: { taskId: "a", stage: "in-review" } },
      isUndoWanted: undefined,
    });
    scope.pendingIntents.hold(ANSWER);

    scopes.close();
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);

    expect(scope.undoStack.holds(moved)).toBe(false);
    expect(scope.pendingCardMoves.getSnapshot()).toEqual([]);
    expect(respondToQuestion).not.toHaveBeenCalled();
  });

  it("starts a new user with nothing in memory, and finds the first user's unsent answer only under the first user", async () => {
    const { scopes, respondToQuestion } = setUp();
    const ada = scopes.open("ada");
    const moved = { words: "Moved a", undo: () => Promise.resolve(undefined) };
    ada.undoStack.reserve(moved, Promise.resolve(true));
    ada.pendingIntents.hold(ANSWER);

    const bob = scopes.open("bob");
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);

    expect(bob.pendingIntents.getSnapshot()).toEqual([]);
    expect(bob.undoStack.holds(moved)).toBe(false);
    expect(respondToQuestion).not.toHaveBeenCalled();

    // Back to the first user: the answer comes back unsent, and is never sent by itself.
    const adaAgain = scopes.open("ada");
    expect(adaAgain).not.toBe(ada);
    expect(adaAgain.pendingIntents.getSnapshot()).toMatchObject([
      { ...ANSWER, state: "failed", failure: { reason: "interrupted" } },
    ]);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);
    expect(respondToQuestion).not.toHaveBeenCalled();
  });

  it("does not send an intent whose timer fires after the token went and before the scope closed", async () => {
    const { scopes, respondToQuestion, signOut } = setUp();
    const scope = scopes.open("ada");
    scope.pendingIntents.hold(ANSWER);

    signOut();
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);

    expect(respondToQuestion).not.toHaveBeenCalled();
    expect(scope.pendingIntents.getSnapshot()).toMatchObject([
      { state: "failed", failure: { message: "You signed out before this was sent." } },
    ]);
  });

  it("fails to read a scope before the shell has opened one", () => {
    const { scopes } = setUp();

    expect(() => scopes.read()).toThrow(/No account scope is open/);
  });
});

describe("the reply drafts of the account scope", () => {
  it("are kept apart per account and dropped when the scope closes", () => {
    const { scopes } = setUp();
    const ada = scopes.open("ada");
    ada.heldSignalAnswers.writeDraft("s1", "reply", "Ada's words");

    const bob = scopes.open("bob");
    expect(bob.heldSignalAnswers.readDraft("s1", "reply")).toBe("");
    expect(ada.heldSignalAnswers.readDraft("s1", "reply")).toBe("");
  });
});
