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

const buildGesture = (hold = vi.fn()): Gesture<null> => ({
  words: "Replied",
  undo: () => Promise.resolve(undefined),
  hold,
});

const setUp = () => {
  const stack = createUndoStack<null>();
  const hook = renderHook(() => useUndoLine(stack, () => null));
  const hold = vi.fn();
  return { hook, gesture: buildGesture(hold), hold };
};

const WAITING = { text: "Replying. Sends in 8s.", offersUndo: true, isWaiting: true };

describe("the undo line for a gesture that waits", () => {
  it("stays past its usual time, then says the sent words without Undo, then goes", async () => {
    const { hook, gesture } = setUp();
    act(() => hook.result.current.say("Replying.", gesture));
    act(() => hook.result.current.restate(gesture, WAITING));

    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(hook.result.current.line).toMatchObject({ isShown: true, canUndo: true });

    act(() =>
      hook.result.current.restate(gesture, {
        text: "Sent to GitHub.",
        offersUndo: false,
        isWaiting: false,
      }),
    );
    expect(hook.result.current.line).toMatchObject({
      isShown: true,
      canUndo: false,
      text: "Sent to GitHub.",
    });

    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(hook.result.current.line.isShown).toBe(false);
  });

  it("changes its words, keeping Undo, while the gesture waits", () => {
    const { hook, gesture } = setUp();
    act(() => hook.result.current.say("Replying.", gesture));
    act(() => hook.result.current.restate(gesture, WAITING));

    act(() =>
      hook.result.current.restate(gesture, {
        text: "Replying. Sends when you let go.",
        offersUndo: true,
        isWaiting: true,
      }),
    );
    expect(hook.result.current.line).toMatchObject({
      canUndo: true,
      text: "Replying. Sends when you let go.",
    });
  });

  it("ignores a gesture that the line no longer shows", () => {
    const { hook, gesture } = setUp();
    act(() => hook.result.current.say("Replying.", gesture));
    act(() => hook.result.current.say("Moved something.", buildGesture()));

    act(() =>
      hook.result.current.restate(gesture, {
        text: "Sent to GitHub.",
        offersUndo: false,
        isWaiting: false,
      }),
    );
    expect(hook.result.current.line).toMatchObject({ text: "Moved something.", canUndo: true });
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
