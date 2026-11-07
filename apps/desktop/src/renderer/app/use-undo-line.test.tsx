/**
 * Tests the undo line: what it says for each thing Undo can do, that a note
 * from the gesture is added, and that the line hides itself a while after it
 * is shown, longer after a failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createUndoStack, type Gesture } from "./undo-stack";
import { useUndoLine } from "./use-undo-line";

const SAVED = Promise.resolve(true);

const reversing = (words: string, note?: string): Gesture<string> => ({
  words,
  undo: () => Promise.resolve(note),
});

describe("useUndoLine", () => {
  it("says nothing was there to undo", async () => {
    const { result } = renderHook(() => useUndoLine(createUndoStack<string>(), () => "page"));

    act(() => {
      result.current.undo();
    });

    await waitFor(() => {
      expect(result.current.line).toMatchObject({
        text: "Nothing to undo.",
        canUndo: false,
        isShown: true,
      });
    });
  });

  it("lets the stack know a page is open while the page is mounted", () => {
    const stack = createUndoStack<string>();
    const { unmount } = renderHook(() => useUndoLine(stack, () => "page"));
    expect(stack.hasOpenPage()).toBe(true);

    unmount();

    expect(stack.hasOpenPage()).toBe(false);
  });

  it("says what was put back, with the note the gesture gives", async () => {
    const stack = createUndoStack<string>();
    stack.reserve(reversing("Moved A"), SAVED);
    stack.reserve(reversing("Moved B", "It went last."), SAVED);
    const { result } = renderHook(() => useUndoLine(stack, () => "page"));

    act(() => {
      result.current.undo();
    });
    await waitFor(() => {
      expect(result.current.line.text).toBe("Put back: Moved B. It went last.");
    });
    act(() => {
      result.current.undo();
    });
    await waitFor(() => {
      expect(result.current.line.text).toBe("Put back: Moved A.");
    });
  });

  it("says why a gesture could not be put back", async () => {
    const stack = createUndoStack<string>();
    stack.reserve(
      { words: "Moved A", undo: () => Promise.reject(new Error("The Task is gone.")) },
      SAVED,
    );
    const { result } = renderHook(() => useUndoLine(stack, () => "page"));

    act(() => {
      result.current.undo();
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
      const { result } = renderHook(() => useUndoLine(createUndoStack<string>(), () => "page"));

      act(() => {
        result.current.say("Moved A.", true);
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
        result.current.say("It did not save.", false);
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

    it("starts the timer again when a new line comes", () => {
      const { result } = renderHook(() => useUndoLine(createUndoStack<string>(), () => "page"));

      act(() => {
        result.current.say("Moved A.", true);
      });
      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      act(() => {
        result.current.say("Moved B.", true);
      });
      act(() => {
        vi.advanceTimersByTime(4_000);
      });

      expect(result.current.line.isShown).toBe(true);
    });
  });
});
