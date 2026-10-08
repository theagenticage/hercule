import { describe, expect, it, vi } from "vitest";
import type { ShelfItem } from "@hercule/client-core";
import {
  buildAssistantDraftKey,
  buildDraftKey,
  createPendingSubmissions,
} from "./pending-submissions";

const THREAD = "0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c60";
const OTHER = "0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c61";

const buildImage = (key: string): ShelfItem => ({
  key,
  name: `${key}.png`,
  sizeBytes: 3,
  file: new File(["png"], `${key}.png`, { type: "image/png" }),
  status: "uploading",
});

describe("createPendingSubmissions", () => {
  it("returns the same empty submission for a thread with none", () => {
    const store = createPendingSubmissions();
    expect(store.read(THREAD)).toEqual({ message: { text: "", attachments: [] }, picks: {} });
    expect(store.read(THREAD)).toBe(store.read(OTHER));
  });

  it("keeps each thread's text and picks apart, and returns the same object until the next change", () => {
    const store = createPendingSubmissions();
    store.writeText(THREAD, "Also the tests");
    store.writePicks(THREAD, { model: "opus" });
    const pending = store.read(THREAD);
    expect(pending).toEqual({
      message: { text: "Also the tests", attachments: [] },
      picks: { model: "opus" },
    });
    expect(store.read(THREAD)).toBe(pending);
    expect(store.read(OTHER)).toEqual({ message: { text: "", attachments: [] }, picks: {} });
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
    expect(store.read(THREAD)).toEqual({
      message: { text: "", attachments: [] },
      picks: { model: "opus" },
    });
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
    store.clearSent(THREAD, { ...message, picks });
    expect(store.read(THREAD)).toBe(store.read(OTHER));
  });

  it("keeps what was typed or picked while the submission was on its way", () => {
    const store = createPendingSubmissions();
    store.writeText(THREAD, "Fix the flaky test");
    store.writePicks(THREAD, { model: "opus" });
    const sent = { ...store.read(THREAD).message, picks: store.read(THREAD).picks };
    store.writeText(THREAD, "Fix the flaky test, and the docs");
    store.writePicks(THREAD, { model: "sonnet" });
    store.clearSent(THREAD, sent);
    expect(store.read(THREAD)).toEqual({
      message: { text: "Fix the flaky test, and the docs", attachments: [] },
      picks: { model: "sonnet" },
    });
  });

  it("keeps a thread that holds only images, and applies each update to its images as they are then", () => {
    const store = createPendingSubmissions();
    store.updateAttachments(THREAD, (shelf) => [...shelf, buildImage("one")]);
    store.updateAttachments(THREAD, (shelf) => [...shelf, buildImage("two")]);
    expect(store.read(THREAD).message.attachments.map((item) => item.key)).toEqual(["one", "two"]);
    store.writeText(THREAD, "Look");
    expect(store.read(THREAD).message.attachments).toHaveLength(2);

    store.updateAttachments(THREAD, () => []);
    store.writeText(THREAD, "");
    expect(store.read(THREAD)).toBe(store.read(OTHER));
  });

  it("clears the images a successful submission sent, and keeps the ones attached since", () => {
    const store = createPendingSubmissions();
    store.updateAttachments(THREAD, () => [buildImage("one")]);
    const sent = { ...store.read(THREAD).message, picks: store.read(THREAD).picks };
    store.updateAttachments(THREAD, (shelf) => [...shelf, buildImage("two")]);
    store.clearSent(THREAD, sent);
    expect(store.read(THREAD).message.attachments.map((item) => item.key)).toEqual(["two"]);
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
