import { describe, expect, it, vi } from "vitest";
import { buildDraftKey, createPendingSubmissions } from "./pending-submissions";

const THREAD = "0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c60";
const OTHER = "0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c61";

describe("createPendingSubmissions", () => {
  it("returns the same empty submission for a thread with none", () => {
    const store = createPendingSubmissions();
    expect(store.read(THREAD)).toEqual({ message: { text: "" }, picks: {} });
    expect(store.read(THREAD)).toBe(store.read(OTHER));
  });

  it("keeps each thread's submission apart", () => {
    const store = createPendingSubmissions();
    const pending = { message: { text: "Also the tests" }, picks: { model: "opus" } };
    store.write(THREAD, pending);
    expect(store.read(THREAD)).toBe(pending);
    expect(store.read(OTHER)).toEqual({ message: { text: "" }, picks: {} });
  });

  it("removes a thread's entry when an empty submission is written", () => {
    const store = createPendingSubmissions();
    store.write(THREAD, { message: { text: "Also the tests" }, picks: {} });
    store.write(THREAD, { message: { text: "" }, picks: {} });
    expect(store.read(THREAD)).toBe(store.read(OTHER));
  });

  it("keeps a failure after the user has cleared the text", () => {
    const store = createPendingSubmissions();
    store.write(THREAD, { message: { text: "" }, picks: {}, failure: "The runner is offline" });
    expect(store.read(THREAD).failure).toBe("The runner is offline");
  });

  it("keeps picks made with no text", () => {
    const store = createPendingSubmissions();
    store.write(THREAD, { message: { text: "" }, picks: { options: { effort: "high" } } });
    expect(store.read(THREAD).picks).toEqual({ options: { effort: "high" } });
  });

  it("tells each subscriber about every write until it unsubscribes", () => {
    const store = createPendingSubmissions();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.write(THREAD, { message: { text: "A" }, picks: {} });
    store.write(OTHER, { message: { text: "B" }, picks: {} });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.write(THREAD, { message: { text: "C" }, picks: {} });
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
