/**
 * Tests the undo line: what it says for each thing Undo can do, that a note
 * from the gesture is added, and that the line hides itself a while after it
 * is shown, longer after a failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createUndoStack, type Gesture } from "./undo-stack";
import { useUndoLine } from "./use-undo-line";

const reversing = (words: string, note?: string): Gesture<string> => ({
  words,
  undo: () => Promise.resolve(note),
});

describe("useUndoLine", () => {
  it("says nothing was there to undo", async () => {
    const { result } = renderHook(() => useUndoLine(createUndoStack<string>()));

    act(() => {
      result.current.undo("page");
    });

    await waitFor(() => {
      expect(result.current.line).toMatchObject({
        text: "Nothing to undo.",
        canUndo: false,
        isShown: true,
      });
    });
  });

  it("says what was put back, with the note the gesture gives", async () => {
    const stack = createUndoStack<string>();
    stack.push(reversing("Moved A"));
    stack.push(reversing("Moved B", "It went last."));
    const { result } = renderHook(() => useUndoLine(stack));

    act(() => {
      result.current.undo("page");
    });
    await waitFor(() => {
      expect(result.current.line.text).toBe("Put back: Moved B. It went last.");
    });
    act(() => {
      result.current.undo("page");
    });
    await waitFor(() => {
      expect(result.current.line.text).toBe("Put back: Moved A.");
    });
  });

  it("says why a gesture could not be put back", async () => {
    const stack = createUndoStack<string>();
    stack.push({ words: "Moved A", undo: () => Promise.reject(new Error("The Task is gone.")) });
    const { result } = renderHook(() => useUndoLine(stack));

    act(() => {
      result.current.undo("page");
    });

    await waitFor(() => {
      expect(result.current.line.text).toBe("Could not put back: Moved A. The Task is gone.");
    });
  });

  describe("with a clock", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("hides a line after 5.2 seconds, and a line without Undo after 8", () => {
      const stack = createUndoStack<string>();
      const moved = reversing("Moved A");
      stack.push(moved);
      const { result } = renderHook(() => useUndoLine(stack));

      act(() => {
        result.current.say("Moved A.", moved);
      });
      act(() => {
        vi.advanceTimersByTime(5_100);
      });
      expect(result.current.line.isShown).toBe(true);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(result.current.line.isShown).toBe(false);
      // The words stay while the line fades out.
      expect(result.current.line.text).toBe("Moved A.");

      act(() => {
        result.current.say("It did not save.");
      });
      act(() => {
        vi.advanceTimersByTime(7_900);
      });
      expect(result.current.line.isShown).toBe(true);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(result.current.line.isShown).toBe(false);
    });

    it("stops offering Undo when its gesture leaves the stack, so Undo cannot reach an older gesture", () => {
      const stack = createUndoStack<string>();
      const older = reversing("Moved A");
      const held = reversing("Answered B");
      stack.push(older);
      stack.push(held);
      const { result } = renderHook(() => useUndoLine(stack));
      act(() => {
        result.current.say("Answered B.", held);
      });
      expect(result.current.line.canUndo).toBe(true);

      // The held answer is sent at 5.0 s and leaves the stack; the line stays until 5.2 s.
      act(() => {
        vi.advanceTimersByTime(5_000);
        result.current.withdraw(held);
      });

      expect(result.current.line.isShown).toBe(true);
      expect(result.current.line.canUndo).toBe(false);
      expect(stack.holds(older)).toBe(true);
      // Withdrawing does not give the line more time: it still goes at 5.2 s.
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(result.current.line.isShown).toBe(false);
    });

    it("starts the timer again when a new line comes", () => {
      const { result } = renderHook(() => useUndoLine(createUndoStack<string>()));

      act(() => {
        result.current.say("Moved A.");
      });
      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      act(() => {
        result.current.say("Moved B.");
      });
      act(() => {
        vi.advanceTimersByTime(4_000);
      });

      expect(result.current.line.isShown).toBe(true);
    });
  });
});
