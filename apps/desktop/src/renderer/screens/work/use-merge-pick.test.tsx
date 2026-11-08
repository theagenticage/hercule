/**
 * Tests picking the card to merge into by key, through `useMergePick` on a
 * small hand-made board: focus moves as the arrows move it, and the hook
 * marks the card the walk rests on. What the keys and the screen do around
 * it is covered by the Work screen's integration test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { MergeCheckResult } from "@hercule/client-core/work";
import { buildCard } from "@hercule/client-core/work/testing";
import { useMergePick } from "./use-merge-pick";

const CARDS = [
  buildCard("label", { title: "Label the pallets" }),
  buildCard("weigh", { title: "Weigh the parcels" }),
  buildCard("pack", { title: "Pack the crates" }),
  buildCard("ship", { title: "Ship the order" }),
];

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

let scroller: HTMLElement;

const getCard = (id: string): HTMLElement =>
  scroller.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!;

/** Picks "Label the pallets" and returns the hook with its spies. */
const startPick = (
  checkMerge: (sourceId: string, targetId: string) => Promise<MergeCheckResult>,
) => {
  const merge = vi.fn();
  const say = vi.fn();
  const hook = renderHook(() =>
    useMergePick({
      scrollRef: { current: scroller },
      cards: CARDS,
      initiatives: [],
      merge,
      checkMerge,
      say,
      onStart: () => undefined,
    }),
  );
  act(() => {
    hook.result.current.start(CARDS[0]!);
  });
  // Starting says what to do; the tests look at what comes after.
  say.mockClear();
  return { hook, merge, say };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const desk = document.createElement("div");
  desk.className = "work-desk";
  scroller = document.createElement("div");
  for (const card of CARDS) {
    const element = document.createElement("div");
    element.tabIndex = 0;
    element.dataset["cardId"] = card.id;
    scroller.append(element);
  }
  desk.append(scroller);
  document.body.append(desk);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("confirming while the merge check has not answered", () => {
  it("waits, showing 'Checking', and merges once the check allows it", async () => {
    const check = deferAnswer();
    const { hook, merge, say } = startPick(() => check.promise);
    act(() => {
      getCard("weigh").focus();
    });

    act(() => {
      hook.result.current.confirm("weigh");
    });

    // The pick is still on the card, and nothing says it is approved.
    expect(hook.result.current.sourceId).toBe("label");
    expect(getCard("weigh").dataset["mergeCheck"]).toBe("checking");
    expect(getCard("weigh").dataset["mergeLabel"]).toBe("Checking merge into Weigh the parcels");
    expect(merge).not.toHaveBeenCalled();

    check.answer({ kind: "allowed" });
    await act(() => check.promise.then(() => undefined));

    expect(merge).toHaveBeenCalledExactlyOnceWith("label", "weigh", true);
    expect(say).not.toHaveBeenCalled();
    expect(hook.result.current.sourceId).toBeNull();
  });

  it("merges nothing and says why when the check refuses", async () => {
    const check = deferAnswer();
    const { hook, merge, say } = startPick(() => check.promise);
    act(() => {
      getCard("weigh").focus();
    });
    act(() => {
      hook.result.current.confirm("weigh");
    });

    check.answer({ kind: "refused", refusal: "Pack already waits on this Task." });
    await act(() => check.promise.then(() => undefined));

    expect(merge).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledExactlyOnceWith(
      '"Label the pallets" was not merged: Pack already waits on this Task.',
    );
    expect(hook.result.current.sourceId).toBeNull();
  });

  it("goes ahead unchecked after 2 seconds, and never shows the target as approved", async () => {
    const { hook, merge } = startPick(() => deferAnswer().promise);
    act(() => {
      getCard("weigh").focus();
    });
    act(() => {
      hook.result.current.confirm("weigh");
    });

    await act(() => vi.advanceTimersByTimeAsync(1900));
    expect(merge).not.toHaveBeenCalled();
    expect(getCard("weigh").dataset["mergeCheck"]).toBe("checking");

    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(merge).toHaveBeenCalledExactlyOnceWith("label", "weigh", false);
  });

  it("goes ahead unchecked at once when the question could not be asked", async () => {
    const { hook, merge } = startPick(() => Promise.resolve({ kind: "unchecked" }));
    act(() => {
      getCard("weigh").focus();
    });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(getCard("weigh").dataset["mergeCheck"]).toBe("unchecked");

    act(() => {
      hook.result.current.confirm("weigh");
    });

    expect(merge).toHaveBeenCalledExactlyOnceWith("label", "weigh", false);
  });

  it("drops the wait when the walk moves to another card", async () => {
    const check = deferAnswer();
    const { hook, merge } = startPick(() => check.promise);
    act(() => {
      getCard("weigh").focus();
    });
    act(() => {
      hook.result.current.confirm("weigh");
    });

    act(() => {
      getCard("pack").focus();
    });
    check.answer({ kind: "allowed" });
    await act(() => check.promise.then(() => undefined));

    expect(merge).not.toHaveBeenCalled();
    expect(hook.result.current.sourceId).toBe("label");
  });
});

describe("walking with the arrows", () => {
  it("asks the controller once, about the card the walk rests on", async () => {
    const checkMerge = vi.fn(() => Promise.resolve({ kind: "allowed" } as const));
    startPick(checkMerge);

    for (const id of ["weigh", "pack", "ship"]) {
      act(() => {
        getCard(id).focus();
      });
      await act(() => vi.advanceTimersByTimeAsync(40));
    }
    expect(checkMerge).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(150));

    expect(checkMerge).toHaveBeenCalledExactlyOnceWith("label", "ship");
    expect(getCard("ship").dataset["mergeCheck"]).toBe("allowed");
  });
});
