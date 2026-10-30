/**
 * Tests what the hook adds to client-core's typing guard: it redraws when
 * the guard changes, and it stops the guard's timer on unmount. The rules of
 * the guard are tested in client-core.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { TYPING_PAUSE_MS } from "@hercule/client-core";
import { useTypingGuard } from "./use-typing-guard";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useTypingGuard", () => {
  it("redraws with holding true after an edit, and false after the pause or a release", () => {
    const { result } = renderHook(() => useTypingGuard());
    expect(result.current.holding).toBe(false);

    act(() => {
      result.current.holdAfterEdit();
    });
    expect(result.current.holding).toBe(true);
    act(() => {
      vi.advanceTimersByTime(TYPING_PAUSE_MS);
    });
    expect(result.current.holding).toBe(false);

    act(() => {
      result.current.holdAfterEdit();
    });
    act(() => {
      result.current.release();
    });
    expect(result.current.holding).toBe(false);
  });

  it("keeps one guard across renders, so a composition reported earlier still holds", () => {
    const { result, rerender } = renderHook(() => useTypingGuard());
    act(() => {
      result.current.reportComposing(true);
    });
    rerender();

    act(() => {
      vi.advanceTimersByTime(TYPING_PAUSE_MS * 3);
      result.current.release();
    });

    expect(result.current.holding).toBe(true);
  });

  it("clears the guard's timer when the composer goes away", () => {
    const { result, unmount } = renderHook(() => useTypingGuard());
    act(() => {
      result.current.holdAfterEdit();
    });

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
