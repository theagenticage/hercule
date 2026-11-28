/**
 * Tests the merge intent through its own interface: choosing a target, the
 * merge check and its labels, committing, the wait for a check that has not
 * answered, and what makes an answer stale. The drag and the key pick that
 * feed it are covered by `use-board-drag.test.tsx` and `use-merge-pick.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MergeCheckResult, MergeDecision } from "@hercule/client-core/work";
import { buildCard } from "@hercule/client-core/work/testing";
import { createMergeIntent, type MergeIntent, type MergePair } from "./merge-intent";

const PAIR: MergePair = { sourceId: "refund-emails", targetId: "delivery-slots" };

let target: HTMLElement;
let other: HTMLElement;

/** A check answer the test gives when it chooses. */
const deferAnswer = (): {
  readonly promise: Promise<MergeCheckResult>;
  readonly answer: (result: MergeCheckResult) => void;
} => {
  let answer: (result: MergeCheckResult) => void = () => undefined;
  const promise = new Promise<MergeCheckResult>((resolve) => {
    answer = resolve;
  });
  return { promise, answer };
};

/** Creates an intent on a board of three cards whose merge check is `askCheck`. */
const createIntent = (
  askCheck: (sourceId: string, targetId: string) => Promise<MergeCheckResult>,
  askAfterMs = 0,
): MergeIntent =>
  createMergeIntent({
    readCards: () => [
      buildCard("delivery-slots", { title: "Delivery slots", initiativeId: "checkout" }),
      buildCard("refund-emails", { title: "Refund emails", initiativeId: "billing" }),
      buildCard("gift-wrap", { title: "Gift wrap" }),
    ],
    readInitiatives: () => [{ id: "checkout", name: "Checkout", hue: 245 }],
    askCheck,
    askAfterMs,
  });

/** Lets the answer of a check, which arrives as a promise, reach the intent. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** Commits and returns what the intent called, in order. */
const commitAndRecord = (intent: MergeIntent, withCancel = false) => {
  const decisions: MergeDecision[] = [];
  const cancel = vi.fn();
  const isCommitted = intent.commit({
    onDecision: (decision) => decisions.push(decision),
    ...(withCancel ? { onCancel: cancel } : {}),
  });
  return { decisions, cancel, isCommitted };
};

const pressEscape = (): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  target = document.createElement("div");
  other = document.createElement("div");
  document.body.append(target, other);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("choosing a target", () => {
  it("shows the target as checking, promising nothing, until the controller answers", async () => {
    const check = deferAnswer();
    const ask = vi.fn(() => check.promise);
    const intent = createIntent(ask);

    expect(intent.choose({ ...PAIR, element: target })).toBe(true);

    expect(ask).toHaveBeenCalledExactlyOnceWith("refund-emails", "delivery-slots");
    expect(target.hasAttribute("data-merge-target")).toBe(true);
    expect(target.dataset["mergeCheck"]).toBe("checking");
    expect(target.dataset["mergeLabel"]).toBe("Checking merge into Delivery slots");
    expect(target.hasAttribute("data-merge-keeps")).toBe(false);

    check.answer({ kind: "allowed" });
    await settle();
    expect(target.dataset["mergeCheck"]).toBe("allowed");
    expect(target.dataset["mergeLabel"]).toBe("Merge into Delivery slots");
    expect(target.dataset["mergeKeeps"]).toBe(
      "Keeps its title, stage, place and initiative Checkout",
    );
  });

  it("shows a refusal on the target in place of its label", async () => {
    const intent = createIntent(() =>
      Promise.resolve({ kind: "refused", refusal: "Plan the launch already waits on this Task." }),
    );
    intent.choose({ ...PAIR, element: target });
    await settle();

    expect(target.dataset["mergeLabel"]).toBe(
      "Cannot merge: Plan the launch already waits on this Task",
    );
    expect(target.dataset["mergeKeeps"]).toBe("Nothing will be merged");
  });

  it("does not read a question that could not be asked as an approval", async () => {
    const intent = createIntent(() => Promise.resolve({ kind: "unchecked" }));
    intent.choose({ ...PAIR, element: target });
    await settle();

    expect(target.dataset["mergeCheck"]).toBe("unchecked");
    expect(target.dataset["mergeKeeps"]).toBe("Could not check this merge first");
  });

  it("asks once for a pair, however often it is chosen", () => {
    const ask = vi.fn(() => deferAnswer().promise);
    const intent = createIntent(ask);
    intent.choose({ ...PAIR, element: target });
    intent.choose({ ...PAIR, element: target });

    expect(ask).toHaveBeenCalledOnce();
  });

  it("asks only after the target has rested, and not at all when it was left first", async () => {
    const ask = vi.fn(() => Promise.resolve({ kind: "allowed" } as const));
    const intent = createIntent(ask, 150);

    intent.choose({ ...PAIR, element: target });
    await vi.advanceTimersByTimeAsync(149);
    expect(ask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ask).toHaveBeenCalledOnce();

    intent.choose({ sourceId: "refund-emails", targetId: "gift-wrap", element: other });
    intent.leave();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("chooses nothing when the target card is no longer on the board", () => {
    const ask = vi.fn(() => deferAnswer().promise);
    const intent = createIntent(ask);

    expect(intent.choose({ sourceId: "refund-emails", targetId: "gone", element: target })).toBe(
      false,
    );

    expect(ask).not.toHaveBeenCalled();
    expect(target.hasAttribute("data-merge-target")).toBe(false);
    expect(commitAndRecord(intent).isCommitted).toBe(false);
  });

  it("takes the marks off when it is left, and ignores the answer that comes late", async () => {
    const check = deferAnswer();
    const intent = createIntent(() => check.promise);
    intent.choose({ ...PAIR, element: target });

    intent.leave();
    check.answer({ kind: "refused", refusal: "Too late." });
    await settle();

    expect(target.hasAttribute("data-merge-target")).toBe(false);
    expect(target.hasAttribute("data-merge-label")).toBe(false);
    expect(target.hasAttribute("data-merge-check")).toBe(false);
  });

  it("ignores the answer for a target that another target replaced", async () => {
    const first = deferAnswer();
    const second = deferAnswer();
    const intent = createIntent((_sourceId, targetId) =>
      targetId === "delivery-slots" ? first.promise : second.promise,
    );
    intent.choose({ ...PAIR, element: target });
    intent.choose({ sourceId: "refund-emails", targetId: "gift-wrap", element: other });

    first.answer({ kind: "refused", refusal: "Stale." });
    await settle();
    expect(other.dataset["mergeCheck"]).toBe("checking");
    expect(target.hasAttribute("data-merge-target")).toBe(false);

    second.answer({ kind: "allowed" });
    await settle();
    expect(other.dataset["mergeCheck"]).toBe("allowed");
  });
});

describe("committing when the check has answered", () => {
  it.each<[string, MergeCheckResult, MergeDecision]>([
    ["accepts what the check allowed", { kind: "allowed" }, { kind: "accepted" }],
    [
      "refuses with the words for the undo line",
      { kind: "refused", refusal: "Plan the launch already waits on this Task." },
      {
        kind: "refused",
        words: '"Refund emails" was not merged: Plan the launch already waits on this Task.',
      },
    ],
    [
      "goes ahead unchecked after a question that could not be asked",
      { kind: "unchecked" },
      { kind: "unchecked" },
    ],
  ])("%s", async (_name, answer, expected) => {
    const intent = createIntent(() => Promise.resolve(answer));
    intent.choose({ ...PAIR, element: target });
    await settle();

    const { decisions, isCommitted } = commitAndRecord(intent);

    expect(isCommitted).toBe(true);
    expect(decisions).toEqual([expected]);
    expect(intent.isWaiting()).toBe(false);
  });

  it("leaves the marks on the target until it is left", async () => {
    const intent = createIntent(() => Promise.resolve({ kind: "allowed" }));
    intent.choose({ ...PAIR, element: target });
    await settle();
    commitAndRecord(intent);
    expect(target.hasAttribute("data-merge-target")).toBe(true);

    intent.leave();

    expect(target.hasAttribute("data-merge-target")).toBe(false);
  });

  it("does nothing when no target is chosen", () => {
    const { decisions, isCommitted } = commitAndRecord(createIntent(() => deferAnswer().promise));

    expect(isCommitted).toBe(false);
    expect(decisions).toEqual([]);
  });
});

describe("committing while the check has not answered", () => {
  it("waits, asks at once, and decides when the check allows it", async () => {
    const check = deferAnswer();
    const ask = vi.fn(() => check.promise);
    const intent = createIntent(ask, 150);
    intent.choose({ ...PAIR, element: target });
    expect(ask).not.toHaveBeenCalled();

    const { decisions } = commitAndRecord(intent);

    expect(ask).toHaveBeenCalledOnce();
    expect(intent.isWaiting()).toBe(true);
    expect(decisions).toEqual([]);
    expect(target.dataset["mergeCheck"]).toBe("checking");

    check.answer({ kind: "allowed" });
    await settle();
    expect(decisions).toEqual([{ kind: "accepted" }]);
    expect(intent.isWaiting()).toBe(false);
    // The target is left as it was when committed: the answer does not repaint it.
    expect(target.dataset["mergeCheck"]).toBe("checking");
  });

  it("decides a refusal with its words", async () => {
    const check = deferAnswer();
    const intent = createIntent(() => check.promise);
    intent.choose({ ...PAIR, element: target });
    const { decisions } = commitAndRecord(intent);

    check.answer({ kind: "refused", refusal: "Plan the launch already waits on this Task." });
    await settle();

    expect(decisions).toEqual([
      {
        kind: "refused",
        words: '"Refund emails" was not merged: Plan the launch already waits on this Task.',
      },
    ]);
  });

  it("decides unchecked after 2 seconds, never approved, and ignores the answer that comes late", async () => {
    const check = deferAnswer();
    const intent = createIntent(() => check.promise);
    intent.choose({ ...PAIR, element: target });
    const { decisions } = commitAndRecord(intent);

    await vi.advanceTimersByTimeAsync(1999);
    expect(decisions).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(decisions).toEqual([{ kind: "unchecked" }]);

    check.answer({ kind: "allowed" });
    await settle();
    expect(decisions).toEqual([{ kind: "unchecked" }]);
    expect(target.dataset["mergeCheck"]).toBe("checking");
  });

  it("ignores a second commit while one waits", async () => {
    const check = deferAnswer();
    const intent = createIntent(() => check.promise);
    intent.choose({ ...PAIR, element: target });
    const first = commitAndRecord(intent);
    const second = commitAndRecord(intent);

    check.answer({ kind: "allowed" });
    await settle();

    expect(second.isCommitted).toBe(false);
    expect(first.decisions).toEqual([{ kind: "accepted" }]);
    expect(second.decisions).toEqual([]);
  });

  it("drops the wait without a decision when the target is left", async () => {
    const check = deferAnswer();
    const intent = createIntent(() => check.promise);
    intent.choose({ ...PAIR, element: target });
    const { decisions, cancel } = commitAndRecord(intent, true);

    intent.leave();
    check.answer({ kind: "allowed" });
    await vi.advanceTimersByTimeAsync(3000);

    expect(decisions).toEqual([]);
    expect(cancel).not.toHaveBeenCalled();
    expect(intent.isWaiting()).toBe(false);
  });

  it("waits on a target chosen with no element, such as one clicked, and marks nothing", async () => {
    const check = deferAnswer();
    const intent = createIntent(() => check.promise, 150);
    intent.choose(PAIR);
    const { decisions } = commitAndRecord(intent);

    check.answer({ kind: "allowed" });
    await settle();

    expect(decisions).toEqual([{ kind: "accepted" }]);
    expect(target.hasAttribute("data-merge-target")).toBe(false);
  });
});

describe("a commit that is cancelled while it waits", () => {
  /** Commits to a check that has not answered, with a cancel. */
  const commitWaiting = () => {
    const check = deferAnswer();
    const intent = createIntent(() => check.promise);
    intent.choose({ ...PAIR, element: target });
    return { intent, check, ...commitAndRecord(intent, true) };
  };

  it("cancels on Esc, takes the key, and ignores the answer and the time that come late", async () => {
    const { check, decisions, cancel, intent } = commitWaiting();

    const event = pressEscape();

    expect(event.defaultPrevented).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(intent.isWaiting()).toBe(false);
    check.answer({ kind: "allowed" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(decisions).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels when the window loses the focus, and not again when the time runs out", async () => {
    const { decisions, cancel } = commitWaiting();

    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(3000);

    expect(cancel).toHaveBeenCalledOnce();
    expect(decisions).toEqual([]);
  });

  it("cancels when the window is hidden", () => {
    const { cancel } = commitWaiting();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);

    document.dispatchEvent(new Event("visibilitychange"));
    hidden.mockRestore();

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("stops watching once the merge is decided", async () => {
    const { check, decisions, cancel } = commitWaiting();
    check.answer({ kind: "allowed" });
    await settle();

    const event = pressEscape();
    window.dispatchEvent(new Event("blur"));

    expect(event.defaultPrevented).toBe(false);
    expect(decisions).toEqual([{ kind: "accepted" }]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not watch a commit that has no cancel", async () => {
    const check = deferAnswer();
    const intent = createIntent(() => check.promise);
    intent.choose({ ...PAIR, element: target });
    const { decisions } = commitAndRecord(intent);

    const event = pressEscape();
    window.dispatchEvent(new Event("blur"));
    check.answer({ kind: "allowed" });
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(decisions).toEqual([{ kind: "accepted" }]);
  });
});
