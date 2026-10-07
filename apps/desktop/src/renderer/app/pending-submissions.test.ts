import { describe, expect, it, vi } from "vitest";
import {
  buildAssistantDraftKey,
  buildDraftKey,
  createPendingSubmissions,
} from "./pending-submissions";

const THREAD = "0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c60";
const OTHER = "0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c61";

describe("createPendingSubmissions", () => {
  it("returns the same empty submission for a thread with none", () => {
    const store = createPendingSubmissions();
    expect(store.read(THREAD)).toEqual({ message: { text: "" }, picks: {} });
    expect(store.read(THREAD)).toBe(store.read(OTHER));
  });

  it("keeps each thread's text and picks apart, and returns the same object until the next change", () => {
    const store = createPendingSubmissions();
    store.writeText(THREAD, "Also the tests");
    store.writePicks(THREAD, { model: "opus" });
    const pending = store.read(THREAD);
    expect(pending).toEqual({ message: { text: "Also the tests" }, picks: { model: "opus" } });
    expect(store.read(THREAD)).toBe(pending);
    expect(store.read(OTHER)).toEqual({ message: { text: "" }, picks: {} });
  });

  it("removes a thread's entry once it holds no text, no picks and no failure", () => {
    const store = createPendingSubmissions();
    store.writeText(THREAD, "Also the tests");
    store.writeText(THREAD, "");
    expect(store.read(THREAD)).toBe(store.read(OTHER));
  });

  it("keeps picks made with no text", () => {
    const store = createPendingSubmissions();
    store.writePicks(THREAD, { options: { effort: "high" } });
    expect(store.read(THREAD).picks).toEqual({ options: { effort: "high" } });
  });

  it("keeps a failure while the user edits, until it is cleared", () => {
    const store = createPendingSubmissions();
    store.writeText(THREAD, "Fix the flaky test");
    store.recordFailure(THREAD, "The runner is offline");
    store.writeText(THREAD, "");
    store.writePicks(THREAD, { model: "opus" });
    expect(store.read(THREAD).failure).toBe("The runner is offline");

    store.clearFailure(THREAD);
    expect(store.read(THREAD)).toEqual({ message: { text: "" }, picks: { model: "opus" } });
  });

  it("leaves a thread with no failure unchanged when its failure is cleared", () => {
    const store = createPendingSubmissions();
    store.writeText(THREAD, "Fix the flaky test");
    const pending = store.read(THREAD);
    const listener = vi.fn();
    store.subscribe(listener);
    store.clearFailure(THREAD);
    expect(store.read(THREAD)).toBe(pending);
    expect(listener).not.toHaveBeenCalled();
  });

  it("clears what a successful submission sent, and its failure", () => {
    const store = createPendingSubmissions();
    store.writeText(THREAD, "Fix the flaky test");
    store.writePicks(THREAD, { model: "opus" });
    store.recordFailure(THREAD, "The runner is offline");
    const { message, picks } = store.read(THREAD);
    store.clearSent(THREAD, { text: message.text, picks });
    expect(store.read(THREAD)).toBe(store.read(OTHER));
  });

  it("keeps what was typed or picked while the submission was on its way", () => {
    const store = createPendingSubmissions();
    store.writeText(THREAD, "Fix the flaky test");
    store.writePicks(THREAD, { model: "opus" });
    const sent = { text: store.read(THREAD).message.text, picks: store.read(THREAD).picks };
    store.writeText(THREAD, "Fix the flaky test, and the docs");
    store.writePicks(THREAD, { model: "sonnet" });
    store.clearSent(THREAD, sent);
    expect(store.read(THREAD)).toEqual({
      message: { text: "Fix the flaky test, and the docs" },
      picks: { model: "sonnet" },
    });
  });

  it("tells each subscriber about every change until it unsubscribes", () => {
    const store = createPendingSubmissions();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.writeText(THREAD, "A");
    store.writeText(OTHER, "B");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.writeText(THREAD, "C");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("buildDraftKey", () => {
  it("gives each place a thread can start from its own key, apart from every session id", () => {
    const keys = [
      buildDraftKey(null, null),
      buildDraftKey(THREAD, null),
      buildDraftKey(THREAD, OTHER),
      buildDraftKey(OTHER, null),
    ];
    expect(new Set(keys).size).toBe(4);
    expect(keys).not.toContain(THREAD);
  });
});

describe("buildAssistantDraftKey", () => {
  it("gives each assistant its own key, apart from every session id and every Draft Thread's key", () => {
    const assistantKey = buildAssistantDraftKey(THREAD);
    expect(assistantKey).not.toBe(buildAssistantDraftKey(OTHER));
    expect([
      THREAD,
      buildDraftKey(null, null),
      buildDraftKey(THREAD, null),
      buildDraftKey(THREAD, OTHER),
    ]).not.toContain(assistantKey);
  });
});
