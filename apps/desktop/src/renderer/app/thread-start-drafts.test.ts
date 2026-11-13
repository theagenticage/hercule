/** Tests how the unsent start-thread drafts change, and which are kept when their dialog closes. */
import { describe, expect, it, vi } from "vitest";
import { buildInboxThing } from "@hercule/client-core/inbox/testing";
import { createThreadStartDrafts, type SentThread } from "./thread-start-drafts";

const things = [buildInboxThing("1", { title: "Checkout fails" })];
const sent = { draftKey: "1" } as SentThread;
const closed = { isStarting: false, hasStarted: false };

const openStore = () => {
  const drafts = createThreadStartDrafts();
  drafts.open("1", things);
  return drafts;
};

describe("open", () => {
  it("creates a draft with the first thing's name and the default starter's words", () => {
    const draft = openStore().read("1");
    expect(draft).toMatchObject({
      title: "Checkout fails",
      starter: "investigate",
      chosenProject: undefined,
      picks: {},
      attempt: undefined,
      isEdited: false,
      failure: null,
    });
    expect(draft?.text).toMatch(/^Look into this/);
  });

  it("leaves an existing draft as it is, and tells nobody", () => {
    const drafts = openStore();
    drafts.edit("1", { text: "mine" });
    const listener = vi.fn();
    drafts.subscribe(listener);
    drafts.open("1", things);
    expect(drafts.read("1")?.text).toBe("mine");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("edit", () => {
  it("applies the patch and marks the draft edited", () => {
    const drafts = openStore();
    drafts.edit("1", { text: "mine", starter: "own" });
    expect(drafts.read("1")).toMatchObject({ text: "mine", starter: "own", isEdited: true });
  });

  it("marks the draft edited for an empty patch, as an attached image does", () => {
    const drafts = openStore();
    drafts.edit("1", {});
    expect(drafts.read("1")?.isEdited).toBe(true);
  });

  it("voids the attempt, because its dedup key belongs to the draft as it was sent", () => {
    const drafts = openStore();
    drafts.recordAttempt("1", sent);
    drafts.edit("1", { title: "Other" });
    expect(drafts.read("1")?.attempt).toBeUndefined();
  });

  it("keeps the failure unless the change answers it", () => {
    const drafts = openStore();
    drafts.recordFailure("1", "refused");
    drafts.edit("1", { text: "a" });
    expect(drafts.read("1")?.failure).toBe("refused");
    drafts.edit("1", { text: "b" }, { answersFailure: true });
    expect(drafts.read("1")?.failure).toBeNull();
  });

  it("does nothing for a key with no draft", () => {
    const drafts = createThreadStartDrafts();
    drafts.edit("1", { text: "a" });
    expect(drafts.read("1")).toBeUndefined();
  });
});

describe("recordAttempt and recordFailure", () => {
  it("keeps the request of the attempt, and does not count as an edit", () => {
    const drafts = openStore();
    drafts.recordAttempt("1", sent);
    expect(drafts.read("1")).toMatchObject({ attempt: sent, isEdited: false });
  });

  it("records a failure and removes it with null, leaving the attempt", () => {
    const drafts = openStore();
    drafts.recordAttempt("1", sent);
    drafts.recordFailure("1", "refused");
    expect(drafts.read("1")).toMatchObject({ failure: "refused", attempt: sent });
    drafts.recordFailure("1", null);
    expect(drafts.read("1")?.failure).toBeNull();
  });

  it("does nothing for a key with no draft", () => {
    const drafts = createThreadStartDrafts();
    drafts.recordFailure("1", "refused");
    drafts.recordAttempt("1", sent);
    expect(drafts.read("1")).toBeUndefined();
  });
});

describe("settle", () => {
  it("drops a draft nobody changed or sent", () => {
    const drafts = openStore();
    expect(drafts.settle("1", closed)).toBe(false);
    expect(drafts.read("1")).toBeUndefined();
  });

  it("keeps an edited draft, a sent one and a failed one", () => {
    const edited = openStore();
    edited.edit("1", { text: "a" });
    const attempted = openStore();
    attempted.recordAttempt("1", sent);
    const failed = openStore();
    failed.recordFailure("1", "refused");
    for (const drafts of [edited, attempted, failed]) {
      expect(drafts.settle("1", closed)).toBe(true);
      expect(drafts.read("1")).toBeDefined();
    }
  });

  it("drops the draft of a thread that started, edited or not", () => {
    const drafts = openStore();
    drafts.edit("1", { text: "a" });
    expect(drafts.settle("1", { isStarting: false, hasStarted: true })).toBe(false);
    expect(drafts.read("1")).toBeUndefined();
  });

  it("leaves the draft to the send that is on its way, even an unedited one", () => {
    const drafts = openStore();
    expect(drafts.settle("1", { isStarting: true, hasStarted: false })).toBe(false);
    expect(drafts.read("1")).toBeDefined();
  });

  it("does nothing for a key with no draft", () => {
    expect(createThreadStartDrafts().settle("1", closed)).toBe(false);
  });
});

describe("finish, clear and subscribe", () => {
  it("removes one draft, or all, and tells the listeners once per change", () => {
    const drafts = openStore();
    drafts.open("2", things);
    const listener = vi.fn();
    const stop = drafts.subscribe(listener);
    drafts.finish("1");
    drafts.finish("1");
    expect(listener).toHaveBeenCalledTimes(1);
    drafts.clear();
    expect(drafts.read("2")).toBeUndefined();
    stop();
    drafts.open("3", things);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
