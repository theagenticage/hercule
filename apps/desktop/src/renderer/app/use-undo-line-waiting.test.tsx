/** Tests how the undo line lives as long as a gesture that waits, through the hook. */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUndoStack, type Gesture } from "./undo-stack";
import { useUndoLine } from "./use-undo-line";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const setUp = () => {
  const stack = createUndoStack<null>();
  const hook = renderHook(() => useUndoLine(stack, () => null));
  let settle: (words: string | undefined) => void = () => undefined;
  const hold = vi.fn();
  const gesture: Gesture<null> = {
    words: "Replied",
    undo: () => Promise.resolve(undefined),
    hold,
    settled: new Promise((resolve) => {
      settle = resolve;
    }),
  };
  return { hook, gesture, settle: (words: string | undefined) => settle(words), hold };
};

describe("the undo line for a gesture that waits", () => {
  it("stays past its usual time, then says the sent words without Undo, then goes", async () => {
    const { hook, gesture, settle } = setUp();
    act(() => hook.result.current.say("Replying.", gesture));

    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(hook.result.current.line).toMatchObject({
      isShown: true,
      canUndo: true,
      text: "Replying.",
    });

    settle("Sent to GitHub.");
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(hook.result.current.line).toMatchObject({
      isShown: true,
      canUndo: false,
      text: "Sent to GitHub.",
    });

    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(hook.result.current.line.isShown).toBe(false);
  });

  it("ends on its own timer when the gesture stops waiting without being sent", async () => {
    const { hook, gesture, settle } = setUp();
    act(() => hook.result.current.say("Replying.", gesture));

    settle(undefined);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(hook.result.current.line.isShown).toBe(false);
  });

  it("tells the gesture when the user is on the line and when they leave", () => {
    const { hook, gesture, hold } = setUp();
    act(() => hook.result.current.say("Replying.", gesture));

    act(() => hook.result.current.hold(true));
    act(() => hook.result.current.hold(false));
    expect(hold.mock.calls).toEqual([[true], [false]]);
  });

  it("lets go of a held gesture when the page unmounts, so it is not stranded", () => {
    const { hook, gesture, hold } = setUp();
    act(() => hook.result.current.say("Replying.", gesture));
    act(() => hook.result.current.hold(true));

    hook.unmount();
    expect(hold.mock.calls).toEqual([[true], [false]]);
  });
});
